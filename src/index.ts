import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@mariozechner/pi-coding-agent";

import {
  GuardrailsController,
  isPermissionMode,
  PERMISSIONS_EVENT_CHANNEL,
  PERMISSIONS_SELECTOR_TITLE,
  type PermissionDecision,
  type PermissionMode,
  type GuardrailsToolRegistration,
} from "./guardrails.ts";

export {
  GuardrailsController,
  NORMAL_PROMPT_TITLE,
  PERMISSIONS_EVENT_CHANNEL,
  PERMISSIONS_SELECTOR_TITLE,
  STRICT_PROMPT_TITLE,
  isPermissionMode,
  registerGuardrailsToolContract,
  type ExtensionRegistration,
  type GuardrailsClassification,
  type GuardrailsControllerOptions,
  type GuardrailsDecisionInput,
  type GuardrailsToolContext,
  type GuardrailsToolContract,
  type GuardrailsToolRegistration,
  type PermissionDecision,
  type PermissionMode,
} from "./guardrails.ts";

function toUserFacingPermissions(value: PermissionMode): "Default" | "Full Access" {
  return value === "default" ? "Default" : "Full Access";
}

function parseInitialPermissions(raw: boolean | string | undefined): PermissionMode {
  return typeof raw === "string" && isPermissionMode(raw) ? raw : "default";
}

function updateStatus(controller: GuardrailsController, ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(
    "pi-guardrails",
    `permissions:${toUserFacingPermissions(controller.getPermissions())}`,
  );
}

async function showPermissionsSelector(
  controller: GuardrailsController,
  ctx: ExtensionContext,
): Promise<void> {
  if (!ctx.hasUI) return;

  const choice = await ctx.ui.select(PERMISSIONS_SELECTOR_TITLE, ["Default", "Full Access"]);
  if (!choice) return;

  controller.setPermissions(choice === "Default" ? "default" : "full-access");
  updateStatus(controller, ctx);
}

async function resolveDecision(
  controller: GuardrailsController,
  decision: PermissionDecision,
  event: ToolCallEvent,
  ctx: ExtensionContext,
) {
  if (decision.outcome === "allow") return undefined;
  if (decision.outcome === "block") return { block: true, reason: decision.reason };

  if (!ctx.hasUI) {
    return { block: true, reason: `Blocked by pi-guardrails: ${event.toolName} requires approval` };
  }

  if (decision.promptKind === "strict") {
    const ok = await ctx.ui.confirm(decision.title, decision.summary);
    if (ok) return undefined;
    return { block: true, reason: `Blocked by user: ${event.toolName}` };
  }

  const choice = await ctx.ui.select(decision.title, decision.options);
  if (choice === "Yes") return undefined;

  if (decision.scopeCandidate && choice === `Yes, ${decision.scopeCandidate} during this session`) {
    controller.addScopedGrant(event.toolName, decision.scopeCandidate);
    return undefined;
  }

  return { block: true, reason: `Blocked by user: ${event.toolName}` };
}

export default function guardrailsExtension(pi: ExtensionAPI): void {
  let controller = new GuardrailsController({ cwd: process.cwd() });

  pi.registerFlag("permissions", {
    description: "Initial permissions for this runtime session",
    type: "string",
    default: "default",
  });

  pi.registerCommand("permissions", {
    description: "Select permissions for this session",
    handler: async (_args, ctx) => {
      await showPermissionsSelector(controller, ctx);
    },
  });

  pi.registerShortcut("ctrl+shift+p", {
    description: "Toggle session permissions",
    handler: (ctx) => {
      controller.togglePermissions();
      updateStatus(controller, ctx);
    },
  });

  pi.events.on(PERMISSIONS_EVENT_CHANNEL, (payload) => {
    const registration = payload as GuardrailsToolRegistration;
    if (!registration?.toolName || !registration?.contract) return;
    controller.registerToolContract(registration);
  });

  pi.on("session_start", (_event, ctx) => {
    controller = new GuardrailsController({
      cwd: ctx.cwd,
      initialPermissions: parseInitialPermissions(pi.getFlag("permissions")),
    });
    updateStatus(controller, ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    updateStatus(controller, ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    const decision = await controller.decide({
      toolName: event.toolName,
      input: event.input,
    });
    return resolveDecision(controller, decision, event, ctx);
  });
}
