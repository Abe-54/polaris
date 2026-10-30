import { expect, test } from "bun:test";
import type { HarnessAvailability } from "@polaris/protocol";
import type { Plain } from "../../../../shared/api.ts";
import { harnessGroups, type ProbedHost } from "../model/harnesses.ts";
import { installedSomewhere, readiness, signInKinds } from "./HarnessesPage.tsx";

const availability = (
  harness: string,
  status: HarnessAvailability["status"],
  signInKind: string | null = null
): Plain<HarnessAvailability> => ({
  harness,
  status,
  version: status === "not-installed" ? null : "2.1.312",
  minVersion: "2.1.0",
  signInKind,
  olderThanTested: null,
  detail: null,
  signInArgv: status === "not-installed" ? null : [`/usr/local/bin/${harness}`, "login"],
});

const reported = (
  hostKey: string,
  harnesses: ReadonlyArray<Plain<HarnessAvailability>>
): ProbedHost => ({
  hostKey,
  label: hostKey === "mac" ? "This Mac" : "Linux VM",
  probe: { kind: "reported", report: { harnesses, checkedAt: "2026-10-30T00:00:00Z" } },
});

const HOSTS = [
  reported("mac", [
    availability("claude", "ready", "Claude Max"),
    availability("codex", "ready", "ChatGPT Pro"),
  ]),
  reported("vm", [availability("claude", "needs-sign-in"), availability("codex", "ready")]),
];

const groups = harnessGroups(HOSTS);

test("the matrix counts ready cells across every harness and host, and who needs sign-in", () => {
  const cells = groups.length * HOSTS.length;

  expect(readiness(groups)).toBe(`3 of ${cells} ready · 1 needs sign-in`);
});

test("sign-in kinds are listed once each, or per harness for its card", () => {
  expect(signInKinds(HOSTS)).toEqual(["Claude Max", "ChatGPT Pro"]);
  expect(signInKinds(HOSTS, "codex")).toEqual(["ChatGPT Pro"]);
});

test("only harnesses on some host get a defaults card", () => {
  expect(groups.filter(installedSomewhere).map((g) => g.kind)).toEqual(["claude", "codex"]);
});
