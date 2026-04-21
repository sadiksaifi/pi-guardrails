import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { GuardrailsController, type PermissionDecision } from "../src/index.ts";

test("package manifest exposes the extension to pi", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    keywords?: string[];
    pi?: { extensions?: string[] };
    peerDependencies?: Record<string, string>;
  };

  expect(packageJson.keywords).toContain("pi-package");
  expect(packageJson.pi?.extensions).toContain("./src/index.ts");
  expect(packageJson.peerDependencies?.["@mariozechner/pi-coding-agent"]).toBe("*");
});

test("full-access skips ordinary built-in file asks", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-guardrails-full-access-"));
  await mkdir(join(cwd, "src"), { recursive: true });

  const controller = new GuardrailsController({
    cwd,
    initialPermissions: "full-access",
  });
  const decision = await controller.decide({
    toolName: "write",
    input: {
      path: "src/index.ts",
      content: "export const mode = 'full-access';",
    },
  });
  const canonicalScope = `write:dir:${await realpath(join(cwd, "src"))}`;

  expect(decision).toEqual<PermissionDecision>({
    outcome: "allow",
    classification: "ask",
    reason: "full-access",
    scopeCandidate: canonicalScope,
  });
});
