import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import guardrailsExtension, {
  type ExtensionRegistration,
  GuardrailsController,
  registerGuardrailsToolContract,
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
  const shortcutHandlers = new Map<string, (ctx: unknown) => void>();
  const commandHandlers = new Map<string, (args: unknown, ctx: unknown) => unknown>();

  const pi = {
    events: registrations.events,
    on(event: string, handler: unknown) {
      registrations.handlers.push({ event, handler });
    },
    registerCommand(
      name: string,
      options: { description?: string; handler: (args: unknown, ctx: unknown) => unknown },
    ) {
      registrations.commands.push({ name, description: options.description });
      commandHandlers.set(name, options.handler);
    },
    registerFlag(
      name: string,
      options: { description?: string; type: string; default?: boolean | string },
    ) {
      registrations.flags.push({
        name,
        description: options.description,
        type: options.type,
        defaultValue: options.default,
      });
    },
    registerShortcut(
      shortcut: string,
      options: { description?: string; handler: (ctx: unknown) => void },
    ) {
      registrations.shortcuts.push({ shortcut, description: options.description });
      shortcutHandlers.set(shortcut, options.handler);
    },
    getFlag() {
      return undefined;
    },
  };

  return { pi, registrations, shortcutHandlers, commandHandlers };
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

test("read-only bash allowlist commands run without prompts", async () => {
  const controller = new GuardrailsController({ cwd: await createTempProject() });

  const decision = await controller.decide({
    toolName: "bash",
    input: { command: "pwd" },
  });

  expect(decision).toEqual<PermissionDecision>({
    outcome: "allow",
    classification: "allow",
    reason: "policy",
  });
});

test("mutating bash commands prompt and offer scoped command-family grants", async () => {
  const controller = new GuardrailsController({ cwd: await createTempProject() });

  const decision = await controller.decide({
    toolName: "bash",
    input: { command: "mkdir build" },
  });

  expect(decision).toEqual<PermissionDecision>({
    outcome: "prompt",
    classification: "ask",
    promptKind: "normal",
    title: "Do you want to allow this action?",
    options: ["Yes", "Yes, shell:prefix:mkdir:* during this session", "No"],
    summary: "bash mkdir build",
    scopeCandidate: "shell:prefix:mkdir:*",
  });
});

test("dangerous bash commands hard-deny catastrophic deletes", async () => {
  const controller = new GuardrailsController({ cwd: await createTempProject() });

  const decision = await controller.decide({
    toolName: "bash",
    input: { command: "rm -rf /" },
  });

  expect(decision).toEqual<PermissionDecision>({
    outcome: "block",
    classification: "deny",
    reason: "Blocked by pi-guardrails: rm -rf /",
  });
});

test("interactive bash commands use the strict direct-interaction prompt", async () => {
  const controller = new GuardrailsController({ cwd: await createTempProject() });

  const decision = await controller.decide({
    toolName: "bash",
    input: { command: "python" },
  });

  expect(decision).toEqual<PermissionDecision>({
    outcome: "prompt",
    classification: "direct-interaction-required",
    promptKind: "strict",
    title: "Do you want to allow this sensitive action?",
    options: ["Yes", "No"],
    summary: "bash python",
  });
});

test("readonly bash sequences run without prompts", async () => {
  const controller = new GuardrailsController({ cwd: await createTempProject() });

  const decision = await controller.decide({
    toolName: "bash",
    input: { command: "pwd && ls" },
  });

  expect(decision).toEqual<PermissionDecision>({
    outcome: "allow",
    classification: "allow",
    reason: "policy",
  });
});

test("readonly bash sequences allow stdout-only printf", async () => {
  const controller = new GuardrailsController({ cwd: await createTempProject() });

  const decision = await controller.decide({
    toolName: "bash",
    input: {
      command:
        "pwd && printf '\\n---\\n' && fd -HI -td -d 2 . . && printf '\\n---FILES---\\n' && fd -HI -tf -d 2 . .",
    },
  });

  expect(decision).toEqual<PermissionDecision>({
    outcome: "allow",
    classification: "allow",
    reason: "policy",
  });
});

test("readonly bash pipelines run without prompts", async () => {
  const controller = new GuardrailsController({ cwd: await createTempProject() });

  const decision = await controller.decide({
    toolName: "bash",
    input: { command: "rg -n foo src | sed -n '1,220p'" },
  });

  expect(decision).toEqual<PermissionDecision>({
    outcome: "allow",
    classification: "allow",
    reason: "policy",
  });
});

test("readonly bash sequences can include readonly pipelines", async () => {
  const controller = new GuardrailsController({ cwd: await createTempProject() });

  const decision = await controller.decide({
    toolName: "bash",
    input: { command: "pwd && rg -n foo src | sed -n '1,220p'" },
  });

  expect(decision).toEqual<PermissionDecision>({
    outcome: "allow",
    classification: "allow",
    reason: "policy",
  });
});

test("printf with redirection cannot use the readonly allowlist", async () => {
  const controller = new GuardrailsController({ cwd: await createTempProject() });

  const decision = await controller.decide({
    toolName: "bash",
    input: { command: "printf 'hello' > out.txt" },
  });

  expect(decision).toEqual<PermissionDecision>({
    outcome: "prompt",
    classification: "ask",
    promptKind: "normal",
    title: "Do you want to allow this action?",
    options: ["Yes", "No"],
    summary: "bash printf 'hello' > out.txt",
  });
});

test("sed in-place edits cannot use the readonly allowlist", async () => {
  const controller = new GuardrailsController({ cwd: await createTempProject() });

  const decision = await controller.decide({
    toolName: "bash",
    input: { command: "sed -i 's/a/b/' file.txt" },
  });

  expect(decision).toEqual<PermissionDecision>({
    outcome: "prompt",
    classification: "ask",
    promptKind: "normal",
    title: "Do you want to allow this action?",
    options: ["Yes", "No"],
    summary: "bash sed -i 's/a/b/' file.txt",
  });
});

test("tee writes inside project require ordinary approval", async () => {
  const controller = new GuardrailsController({ cwd: await createTempProject() });

  const decision = await controller.decide({
    toolName: "bash",
    input: { command: "printf 'hello' | tee out.txt" },
  });

  expect(decision).toEqual<PermissionDecision>({
    outcome: "prompt",
    classification: "ask",
    promptKind: "normal",
    title: "Do you want to allow this action?",
    options: ["Yes", "No"],
    summary: "bash printf 'hello' | tee out.txt",
  });
});

test("tee writes to protected targets use the strict safety prompt", async () => {
  const controller = new GuardrailsController({ cwd: await createTempProject() });

  const decision = await controller.decide({
    toolName: "bash",
    input: { command: "printf 'hello' | tee .env" },
  });

  expect(decision).toEqual<PermissionDecision>({
    outcome: "prompt",
    classification: "safety",
    promptKind: "strict",
    title: "Do you want to allow this sensitive action?",
    options: ["Yes", "No"],
    summary: "bash printf 'hello' | tee .env",
  });
});

test("sed in-place edits to protected targets use the strict safety prompt", async () => {
  const controller = new GuardrailsController({ cwd: await createTempProject() });

  const decision = await controller.decide({
    toolName: "bash",
    input: { command: "sed -i 's/a/b/' .env" },
  });

  expect(decision).toEqual<PermissionDecision>({
    outcome: "prompt",
    classification: "safety",
    promptKind: "strict",
    title: "Do you want to allow this sensitive action?",
    options: ["Yes", "No"],
    summary: "bash sed -i 's/a/b/' .env",
  });
});

test("xargs delegating to rm uses the strict safety prompt", async () => {
  const controller = new GuardrailsController({ cwd: await createTempProject() });

  const decision = await controller.decide({
    toolName: "bash",
    input: { command: "printf 'build\\n' | xargs rm -rf" },
  });

  expect(decision).toEqual<PermissionDecision>({
    outcome: "prompt",
    classification: "safety",
    promptKind: "strict",
    title: "Do you want to allow this sensitive action?",
    options: ["Yes", "No"],
    summary: "bash printf 'build\\n' | xargs rm -rf",
  });
});

test("compound bash commands keep a single clear scope candidate", async () => {
  const controller = new GuardrailsController({ cwd: await createTempProject() });

  const decision = await controller.decide({
    toolName: "bash",
    input: { command: "pwd && mkdir build" },
  });

  expect(decision).toEqual<PermissionDecision>({
    outcome: "prompt",
    classification: "ask",
    promptKind: "normal",
    title: "Do you want to allow this action?",
    options: ["Yes", "Yes, shell:prefix:mkdir:* during this session", "No"],
    summary: "bash pwd && mkdir build",
    scopeCandidate: "shell:prefix:mkdir:*",
  });
});

test("compound bash commands preserve safety even in full-access mode", async () => {
  const controller = new GuardrailsController({
    cwd: await createTempProject(),
    initialPermissions: "full-access",
  });

  const decision = await controller.decide({
    toolName: "bash",
    input: { command: "pwd && rm -rf build" },
  });

  expect(decision).toEqual<PermissionDecision>({
    outcome: "prompt",
    classification: "safety",
    promptKind: "strict",
    title: "Do you want to allow this sensitive action?",
    options: ["Yes", "No"],
    summary: "bash pwd && rm -rf build",
  });
});

test("custom tool contracts can opt into scoped grants", async () => {
  const controller = new GuardrailsController({ cwd: await createTempProject() });
  controller.registerToolContract({
    toolName: "deploy",
    contract: {
      classify: () => "ask",
      getScopeCandidate: () => "deploy:env:staging",
    },
  });

  const promptDecision = await controller.decide({
    toolName: "deploy",
    input: { environment: "staging" },
  });
  controller.addScopedGrant("deploy", "deploy:env:staging");
  const grantedDecision = await controller.decide({
    toolName: "deploy",
    input: { environment: "staging" },
  });

  expect(promptDecision).toEqual<PermissionDecision>({
    outcome: "prompt",
    classification: "ask",
    promptKind: "normal",
    title: "Do you want to allow this action?",
    options: ["Yes", "Yes, deploy:env:staging during this session", "No"],
    summary: "deploy",
    scopeCandidate: "deploy:env:staging",
  });
  expect(grantedDecision).toEqual<PermissionDecision>({
    outcome: "allow",
    classification: "ask",
    reason: "scoped-grant",
    scopeCandidate: "deploy:env:staging",
  });
});

test("registration helper emits custom tool contracts on the shared event bus", () => {
  const emissions: Array<{ channel: string; data: unknown }> = [];

  registerGuardrailsToolContract(
    {
      events: {
        emit(channel, data) {
          emissions.push({ channel, data });
        },
        on() {
          return () => {};
        },
      },
    },
    {
      toolName: "deploy",
      contract: {
        classify: () => "ask",
      },
    },
  );

  expect(emissions).toHaveLength(1);
  expect(emissions[0]?.channel).toBe("pi-guardrails:register-tool-contract");
});

test("extension hides default status and shows full access label in error color", () => {
  const { pi, registrations, shortcutHandlers } = createFakePi();
  const statuses: Array<string | undefined> = [];
  const ui = {
    setStatus(_key: string, value: string | undefined) {
      statuses.push(value);
    },
    theme: {
      fg(color: string, value: string) {
        return `${color.toUpperCase()}(${value})`;
      },
    },
  };

  guardrailsExtension(pi as never);

  const sessionStartHandler = registrations.handlers.find(
    (handler) => handler.event === "session_start",
  )?.handler as
    | ((
        event: unknown,
        ctx: {
          cwd: string;
          hasUI: true;
          ui: typeof ui;
        },
      ) => void)
    | undefined;
  const toggleHandler = shortcutHandlers.get("alt+p");

  sessionStartHandler?.({}, { cwd: process.cwd(), hasUI: true, ui });
  toggleHandler?.({ hasUI: true, ui });
  toggleHandler?.({ hasUI: true, ui });

  expect(statuses).toEqual([undefined, "ERROR(Full Access (unrestricted))", undefined]);
});

test("permissions command shows explanatory options and applies the selected mode", async () => {
  const { pi, commandHandlers, registrations } = createFakePi();
  const selections: Array<{ title: string; options: string[] }> = [];
  const statuses: Array<string | undefined> = [];
  const ui = {
    async select(title: string, options: string[]) {
      selections.push({ title, options });
      return options[1];
    },
    setStatus(_key: string, value: string | undefined) {
      statuses.push(value);
    },
    theme: {
      fg(color: string, value: string) {
        return `${color.toUpperCase()}(${value})`;
      },
    },
  };

  guardrailsExtension(pi as never);

  const sessionStartHandler = registrations.handlers.find(
    (handler) => handler.event === "session_start",
  )?.handler as
    | ((
        event: unknown,
        ctx: {
          cwd: string;
          hasUI: true;
          ui: typeof ui;
        },
      ) => void)
    | undefined;
  const permissionsHandler = commandHandlers.get("permissions");

  sessionStartHandler?.({}, { cwd: process.cwd(), hasUI: true, ui });
  await permissionsHandler?.({}, { hasUI: true, ui });

  expect(selections).toEqual([
    {
      title: "What permissions do you want for this session?",
      options: [
        "Default — ask before writes, shell commands, and other risky actions",
        "Full Access — fewer permission checks for most actions. Recommended only when you trust the agent.",
      ],
    },
  ]);
  expect(statuses).toEqual([undefined, "ERROR(Full Access (unrestricted))"]);
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
    shortcut: "alt+p",
    description: "Toggle session permissions",
  });
});
