import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { GuardrailsController, type PermissionDecision } from "../src/index.ts";

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
