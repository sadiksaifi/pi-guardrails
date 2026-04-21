import { expect, test } from "bun:test";

import guardrailsExtension, {
  type ExtensionRegistration,
  GuardrailsController,
  type PermissionDecision,
} from "../src/index.ts";

function createFakePi() {
  const registrations: ExtensionRegistration = {
    commands: [],
    flags: [],
    shortcuts: [],
    handlers: [],
    events: {
      emit() {},
      on() {
        return () => {};
      },
    },
  };

  const pi = {
    events: registrations.events,
    on(event: string, handler: unknown) {
      registrations.handlers.push({ event, handler });
    },
    registerCommand(name: string, options: { description?: string }) {
      registrations.commands.push({ name, description: options.description });
    },
    registerFlag(name: string, options: { description?: string; type: string; default?: boolean | string }) {
      registrations.flags.push({
        name,
        description: options.description,
        type: options.type,
        defaultValue: options.default,
      });
    },
    registerShortcut(shortcut: string, options: { description?: string }) {
      registrations.shortcuts.push({ shortcut, description: options.description });
    },
    getFlag() {
      return undefined;
    },
  };

  return { pi, registrations };
}

test("controller starts in default permissions and toggles to full-access", async () => {
  const controller = new GuardrailsController({ cwd: process.cwd() });

  expect(controller.getPermissions()).toBe("default");

  controller.togglePermissions();
  expect(controller.getPermissions()).toBe("full-access");

  controller.setPermissions("default");
  expect(controller.getPermissions()).toBe("default");
});

test("non-participating custom tools always require strict approval", async () => {
  const controller = new GuardrailsController({
    cwd: process.cwd(),
    initialPermissions: "full-access",
  });

  const decision = await controller.decide({
    toolName: "deploy",
    input: { environment: "prod" },
  });

  expect(decision).toEqual<PermissionDecision>({
    outcome: "prompt",
    promptKind: "strict",
    title: "Do you want to allow this sensitive action?",
    options: ["Yes", "No"],
    summary: "deploy",
    classification: "explicit-ask",
  });
});

test("extension registers permissions controls", () => {
  const { pi, registrations } = createFakePi();

  guardrailsExtension(pi as never);

  expect(registrations.flags).toContainEqual({
    name: "permissions",
    description: "Initial permissions for this runtime session",
    type: "string",
    defaultValue: "default",
  });
  expect(registrations.commands).toContainEqual({
    name: "permissions",
    description: "Select permissions for this session",
  });
  expect(registrations.shortcuts).toContainEqual({
    shortcut: "ctrl+alt+p",
    description: "Toggle session permissions",
  });
});
