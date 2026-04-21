import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@mariozechner/pi-coding-agent";

export type PermissionMode = "default" | "full-access";
export type GuardrailsClassification =
  | "allow"
  | "ask"
  | "deny"
  | "safety"
  | "direct-interaction-required"
  | "explicit-ask";

export interface GuardrailsToolContext {
  cwd: string;
  permissions: PermissionMode;
}

export interface GuardrailsToolContract<TInput extends Record<string, unknown> = Record<string, unknown>> {
  classify(
    input: TInput,
    context: GuardrailsToolContext,
  ): GuardrailsClassification | Promise<GuardrailsClassification>;
  getScopeCandidate?(
    input: TInput,
    context: GuardrailsToolContext,
  ): string | undefined | Promise<string | undefined>;
  matchesScope?(
    grant: string,
    input: TInput,
    context: GuardrailsToolContext,
  ): boolean | Promise<boolean>;
}

export interface GuardrailsToolRegistration {
  toolName: string;
  contract: GuardrailsToolContract;
}

export interface GuardrailsControllerOptions {
  cwd: string;
  initialPermissions?: PermissionMode;
}

export interface GuardrailsDecisionInput {
  toolName: string;
  input: Record<string, unknown>;
}

export type PermissionDecision =
  | {
      outcome: "allow";
      classification: Extract<GuardrailsClassification, "allow" | "ask">;
      reason: "policy" | "full-access" | "scoped-grant";
      scopeCandidate?: string;
    }
  | {
      outcome: "block";
      classification: "deny";
      reason: string;
    }
  | {
      outcome: "prompt";
      classification: Exclude<GuardrailsClassification, "allow" | "deny">;
      promptKind: "normal" | "strict";
      title: string;
      options: string[];
      summary: string;
      scopeCandidate?: string;
    };

export interface ExtensionRegistration {
  commands: Array<{ name: string; description?: string }>;
  flags: Array<{ name: string; description?: string; type: string; defaultValue?: boolean | string }>;
  shortcuts: Array<{ shortcut: string; description?: string }>;
  handlers: Array<{ event: string; handler: unknown }>;
  events: {
    emit(channel: string, data: unknown): void;
    on(channel: string, handler: (data: unknown) => void): () => void;
  };
}

interface ScopedGrant {
  toolName: string;
  scope: string;
}

const NORMAL_PROMPT_TITLE = "Do you want to allow this action?";
const STRICT_PROMPT_TITLE = "Do you want to allow this sensitive action?";
const PERMISSIONS_SELECTOR_TITLE = "What permissions do you want for this session?";
const PERMISSIONS_EVENT_CHANNEL = "pi-guardrails:register-tool-contract";
const BUILT_IN_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write", "bash"]);

export function registerGuardrailsToolContract(
  events: Pick<ExtensionAPI, "events"> | Pick<ExtensionRegistration, "events">,
  registration: GuardrailsToolRegistration,
): void {
  events.events.emit(PERMISSIONS_EVENT_CHANNEL, registration);
}

function isPermissionMode(value: string | undefined): value is PermissionMode {
  return value === "default" || value === "full-access";
}

function toUserFacingPermissions(value: PermissionMode): "Default" | "Full Access" {
  return value === "default" ? "Default" : "Full Access";
}

export class GuardrailsController {
  private permissions: PermissionMode;
  private readonly cwd: string;
  private readonly scopedGrants: ScopedGrant[] = [];
  private readonly toolContracts = new Map<string, GuardrailsToolContract>();

  constructor(options: GuardrailsControllerOptions) {
    this.cwd = options.cwd;
    this.permissions = options.initialPermissions ?? "default";
  }

  getPermissions(): PermissionMode {
    return this.permissions;
  }

  setPermissions(value: PermissionMode): void {
    this.permissions = value;
  }

  togglePermissions(): PermissionMode {
    this.permissions = this.permissions === "default" ? "full-access" : "default";
    return this.permissions;
  }

  registerToolContract(registration: GuardrailsToolRegistration): void {
    this.toolContracts.set(registration.toolName, registration.contract);
  }

  addScopedGrant(toolName: string, scope: string): void {
    this.scopedGrants.push({ toolName, scope });
  }

  clearScopedGrants(): void {
    this.scopedGrants.length = 0;
  }

  async decide(input: GuardrailsDecisionInput): Promise<PermissionDecision> {
    if (BUILT_IN_TOOLS.has(input.toolName)) {
      return {
        outcome: "allow",
        classification: "allow",
        reason: "policy",
      };
    }

    const contract = this.toolContracts.get(input.toolName);
    if (!contract) {
      return {
        outcome: "prompt",
        classification: "explicit-ask",
        promptKind: "strict",
        title: STRICT_PROMPT_TITLE,
        options: ["Yes", "No"],
        summary: input.toolName,
      };
    }

    const context: GuardrailsToolContext = {
      cwd: this.cwd,
      permissions: this.permissions,
    };
    const classification = await contract.classify(input.input, context);

    if (classification === "allow") {
      return {
        outcome: "allow",
        classification,
        reason: "policy",
      };
    }

    if (classification === "deny") {
      return {
        outcome: "block",
        classification,
        reason: `Blocked by pi-guardrails: ${input.toolName}`,
      };
    }

    if (
      classification === "safety" ||
      classification === "direct-interaction-required" ||
      classification === "explicit-ask"
    ) {
      return {
        outcome: "prompt",
        classification,
        promptKind: "strict",
        title: STRICT_PROMPT_TITLE,
        options: ["Yes", "No"],
        summary: input.toolName,
      };
    }

    if (this.permissions === "full-access") {
      return {
        outcome: "allow",
        classification,
        reason: "full-access",
      };
    }

    return {
      outcome: "prompt",
      classification,
      promptKind: "normal",
      title: NORMAL_PROMPT_TITLE,
      options: ["Yes", "No"],
      summary: input.toolName,
    };
  }
}

function parseInitialPermissions(raw: boolean | string | undefined): PermissionMode {
  return typeof raw === "string" && isPermissionMode(raw) ? raw : "default";
}

function updateStatus(controller: GuardrailsController, ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus("pi-guardrails", `permissions:${toUserFacingPermissions(controller.getPermissions())}`);
}

async function showPermissionsSelector(controller: GuardrailsController, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  const choice = await ctx.ui.select(PERMISSIONS_SELECTOR_TITLE, ["Default", "Full Access"]);
  if (!choice) return;

  controller.setPermissions(choice === "Default" ? "default" : "full-access");
  updateStatus(controller, ctx);
}

async function resolveDecision(decision: PermissionDecision, event: ToolCallEvent, ctx: ExtensionContext) {
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

  pi.registerShortcut("ctrl+alt+p", {
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
    return resolveDecision(decision, event, ctx);
  });
}
