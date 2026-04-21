import { expect, test } from "bun:test";

import { formatGreeting } from "../src/index.ts";

test("formatGreeting uses default value", () => {
  expect(formatGreeting()).toBe("Hello, world!");
});

test("formatGreeting uses provided name", () => {
  expect(formatGreeting("pi")).toBe("Hello, pi!");
});
