import type { ApprovalRequest } from "@polaris/protocol";
import { midnight } from "@polaris/ui/tokens";
import { describe, expect, test } from "bun:test";
import {
  commandApproval,
  NOW,
  question,
  secretRequest,
  type SessionInput,
  session,
} from "../fixtures.testing.ts";
import type { SessionRow } from "../model/home.ts";
import { badgeCount, celestialLook, harnessHue, type MetaLine, metaLine } from "./rowLook.ts";

const row = (
  input: SessionInput,
  extra: { approval?: ApprovalRequest; replyPreview?: string } = {}
): SessionRow => ({
  kind: "session",
  key: `h1/${input.id}`,
  hostId: "h1",
  hostName: "mac-studio",
  workspaceName: "polaris",
  session: session({ harness: "codex", ...input }),
  approval: extra.approval ?? null,
  replyPreview: extra.replyPreview ?? null,
  since: NOW,
  stale: false,
});

describe("metaLine (MX-I)", () => {
  test.each<readonly [string, SessionRow, MetaLine]>([
    [
      "working shows the reply preview and turn",
      row(
        { id: "s", state: "working", turnCount: 24 },
        { replyPreview: "\nWriting index.html\nmore" }
      ),
      { lead: null, rest: "Writing index.html · turn 24" },
    ],
    [
      "a pending command leads with what it wants, then the command's first line",
      row(
        { id: "s", state: "needs-you" },
        { approval: commandApproval("s", "r", "cargo build\n--release") }
      ),
      { lead: { text: "Wants to run a command", tone: "needs-you" }, rest: "$ cargo build" },
    ],
    [
      "a question leads with Asks, then the question",
      row(
        { id: "s", state: "needs-you" },
        { approval: question("s", "r", "Monthly or annual?", ["Annual"]) }
      ),
      { lead: { text: "Asks", tone: "needs-you" }, rest: "Monthly or annual?" },
    ],
    [
      "a secret leads with what it asks for, then the agent's label, never its reason",
      row(
        { id: "s", state: "needs-you" },
        { approval: secretRequest("s", "r", "Tailscale auth key", "To join the tailnet") }
      ),
      { lead: { text: "Asks for a secret", tone: "needs-you" }, rest: "Tailscale auth key" },
    ],
    [
      "done with unreviewed turns is ready to review, in text-default",
      row({ id: "s", state: "idle", turnCount: 3, acceptedThroughIndex: 0 }),
      { lead: { text: "Ready to review", tone: "default" }, rest: "turn 3" },
    ],
    [
      "done with every turn accepted is idle, not ready to review",
      row({ id: "s", state: "idle", turnCount: 3, acceptedThroughIndex: 2 }),
      { lead: { text: "Idle", tone: "default" }, rest: "turn 3" },
    ],
    [
      "failed leads with Failed, then the error's first line",
      row({ id: "s", state: "failed", lastError: "exit 1 in bun test\nstack" }),
      { lead: { text: "Failed", tone: "failed" }, rest: "exit 1 in bun test" },
    ],
    [
      "dormant says it resumes on reply",
      row({ id: "s", state: "dormant" }),
      { lead: null, rest: "Dormant · resumes on reply" },
    ],
  ])("%s", (_, input, expected) => {
    expect(metaLine(input, false)).toEqual(expected);
  });

  test("never names the Harness; names the Host only when there are several", () => {
    const failed = row({ id: "s", state: "failed", lastError: "boom" });

    expect(metaLine(failed, true).rest).toBe("boom · mac-studio");
    expect(metaLine(failed, true).rest).not.toContain("Codex");
  });
});

describe("celestialLook", () => {
  test.each([
    ["working", { working: true, dormant: false }],
    ["starting", { working: false, dormant: false }],
    ["needs-you", { working: false, dormant: false }],
    ["dormant", { working: false, dormant: true }],
    ["archived", { working: false, dormant: true }],
  ] as const)("%s", (state, expected) => {
    expect(celestialLook(state)).toEqual(expected);
  });
});

test("an unknown Harness is neutral", () => {
  expect(harnessHue(midnight, "codex")).toBe(midnight.harnessCodex);
  expect(harnessHue(midnight, "aider")).toBe(midnight.textSubtle);
});

test.each([
  [1, "1"],
  [99, "99"],
  [100, "99+"],
])("the badge shows %i as %s", (count, label) => {
  expect(badgeCount(count)).toBe(label);
});
