import { describe, expect, test } from "bun:test";
import { alwaysAllowable } from "./approvals.ts";
import { helloCapabilities } from "./connection.ts";

describe("alwaysAllowable", () => {
  test.each([
    ["command", true],
    ["file-change", true],
    ["tool", true],
    ["question", false],
    ["secret", false],
    ["app", false],
    ["headed-input", false],
  ] as const)("%s → %p", (kind, expected) => {
    expect(alwaysAllowable({ kind })).toBe(expected);
  });
});

describe("helloCapabilities", () => {
  test("announces computer-use only for an Extension that opted in", () => {
    expect(helloCapabilities(false)).not.toContain("computer-use");
    expect(helloCapabilities(true)).toContain("computer-use");
  });
});
