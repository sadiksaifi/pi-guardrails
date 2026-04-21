import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

async function createTempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-guardrails-"));
}

test("write inside project requires ordinary approval with a directory scope", async () => {
  const cwd = await createTempProject();
  await mkdir(join(cwd, "src"), { recursive: true });

  const controller = new GuardrailsController({ cwd });
  const decision = await controller.decide({
    toolName: "write",
    input: {
      path: "src/index.ts",
      content: "export const answer = 42;",
    },
  });
  const canonicalScope = `write:dir:${await realpath(join(cwd, "src"))}`;

  expect(decision).toEqual<PermissionDecision>({
    outcome: "prompt",
    classification: "ask",
    promptKind: "normal",
    title: "Do you want to allow this action?",
    options: ["Yes", `Yes, ${canonicalScope} during this session`, "No"],
    summary: "write src/index.ts",
    scopeCandidate: canonicalScope,
  });
});

test("protected writes use the strict safety prompt", async () => {
  const cwd = await createTempProject();

  const controller = new GuardrailsController({ cwd });
  const decision = await controller.decide({
    toolName: "write",
    input: {
      path: ".env.production",
      content: "SECRET=1",
    },
  });

  expect(decision).toEqual<PermissionDecision>({
    outcome: "prompt",
    classification: "safety",
    promptKind: "strict",
    title: "Do you want to allow this sensitive action?",
    options: ["Yes", "No"],
    summary: "write .env.production",
  });
});

test("protected-path exclusions keep .env.example as an ordinary write", async () => {
  const cwd = await createTempProject();

  const controller = new GuardrailsController({ cwd });
  const decision = await controller.decide({
    toolName: "write",
    input: {
      path: ".env.example",
      content: "EXAMPLE=1",
    },
  });
  const canonicalScope = `write:dir:${await realpath(cwd)}`;

  expect(decision).toEqual<PermissionDecision>({
    outcome: "prompt",
    classification: "ask",
    promptKind: "normal",
    title: "Do you want to allow this action?",
    options: ["Yes", `Yes, ${canonicalScope} during this session`, "No"],
    summary: "write .env.example",
    scopeCandidate: canonicalScope,
  });
});

test("scoped grants match canonical directories across symlinks", async () => {
  const root = await createTempProject();
  const realDir = join(root, "real");
  const linkDir = join(root, "link");
  await mkdir(realDir, { recursive: true });
  await symlink(realDir, linkDir, "dir");
  await writeFile(join(realDir, "granted.ts"), "export const granted = true;\n");
  const canonicalRealDir = await realpath(realDir);

  const controller = new GuardrailsController({ cwd: root });
  controller.addScopedGrant("edit", `edit:dir:${canonicalRealDir}`);

  const decision = await controller.decide({
    toolName: "edit",
    input: {
      path: join(linkDir, "granted.ts"),
      edits: [{ oldText: "true", newText: "false" }],
    },
  });

  expect(decision).toEqual<PermissionDecision>({
    outcome: "allow",
    classification: "ask",
    reason: "scoped-grant",
    scopeCandidate: `edit:dir:${canonicalRealDir}`,
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
