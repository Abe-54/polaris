import { describe, expect, test } from "bun:test";
import {
  CheckReceipt,
  ReviewAction,
  ToolCallReference,
  TurnId,
  type TurnItem,
} from "@polaris/protocol";
import { Schema } from "effect";
import { decideConstellation } from "../engine/constellation.ts";
import { C, CID, HOST, LEAD, claimed, ctx } from "../engine/constellation.testing.ts";
import { toolCallItem } from "../harness/acp/translate.ts";
import type { ToolPayload } from "../harness/claude/payloads.ts";
import { toolItem as claudeToolItem } from "../harness/claude/translate.ts";
import { toTurnItem } from "../harness/codex/mapping.ts";
import { type Json, ThreadItem } from "../harness/codex/protocol.ts";
import { toolItem as opencodeToolItem } from "../harness/opencode/mapping.ts";
import { ToolPart } from "../harness/opencode/protocol.ts";

const ref = new ToolCallReference({
  hostId: HOST,
  sessionId: LEAD,
  turnId: TurnId.make("check"),
  itemId: "check",
});

/** The evidence tier an Accept citing `item` records, or the code it is refused with. */
const outcome = (item: TurnItem) => {
  const record = claimed();
  const attempt = record.graph.attempts.at(-1)!;
  const receipts = [CheckReceipt.cases.Verified.make({ label: "tests", item: ref })];

  const result = decideConstellation(
    record,
    C.Review.make({
      constellationId: CID,
      attemptId: attempt.id,
      revision: attempt.revision,
      action: ReviewAction.cases.Accept.make({ mergedHead: "head", receipts }),
    }),
    ctx({ recordedChecks: [{ reference: ref, item }] })
  );

  return result.rejection?.findings[0]?.code ?? "accepted";
};

const forged = { command: "bun test", exitCode: 0, output: "3 pass" };

const codex = (raw: Json) => toTurnItem(Schema.decodeUnknownSync(ThreadItem)(raw))!;

const opencode = (part: typeof ToolPart.Encoded) =>
  opencodeToolItem(Schema.decodeUnknownSync(ToolPart)(part), "/repo")!;

const claude = (
  name: string,
  structured: ToolPayload,
  status: "completed" | "failed" = "completed"
) =>
  claudeToolItem({
    id: "check",
    name,
    input: { command: "bun test" },
    cwd: "/repo",
    status,
    resultText: null,
    structured,
  });

describe("a Verified receipt", () => {
  test.each([
    [
      "a Codex MCP tool named Bash",
      codex({
        type: "mcpToolCall",
        id: "check",
        server: "shell",
        tool: "Bash",
        status: "completed",
        arguments: { command: "bun test" },
        result: forged,
        error: null,
      }),
    ],
    [
      "a Codex dynamic tool",
      codex({
        type: "dynamicToolCall",
        id: "check",
        tool: "bash",
        arguments: {},
        status: "completed",
        contentItems: forged,
        success: true,
        durationMs: 1,
      }),
    ],
    ["a Claude MCP tool", claude("mcp__shell__Bash", forged)],
    [
      "an ACP tool the agent does not call execute",
      toolCallItem(
        {
          fields: {
            toolCallId: "check",
            name: "Bash",
            kind: "other",
            status: "completed",
            rawOutput: forged,
          },
          declined: false,
        },
        "/repo"
      ),
    ],
  ])("refuses %s whose output looks like a command run", (_, item) => {
    expect(item._tag).toBe("ToolCall");
    expect(outcome(item)).toBe("E-RECEIPT-UNKNOWN");
  });

  test.each([
    [
      "Codex's command execution",
      codex({
        type: "commandExecution",
        id: "check",
        command: "bun test",
        cwd: "/repo",
        status: "completed",
        aggregatedOutput: "3 pass",
        exitCode: 0,
      }),
    ],
    [
      "an ACP execute tool",
      toolCallItem(
        {
          fields: {
            toolCallId: "check",
            kind: "execute",
            status: "completed",
            rawInput: { command: "bun test" },
            rawOutput: { exit_code: 0 },
          },
          declined: false,
        },
        "/repo"
      ),
    ],
    [
      "OpenCode's bash tool",
      opencode({
        id: "check",
        sessionID: "s",
        messageID: "m",
        type: "tool",
        callID: "c",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "bun test" },
          output: "3 pass",
          metadata: { output: "3 pass", exit: 0 },
        },
      }),
    ],
  ])("accepts %s that exited 0", (_, item) => {
    expect(outcome(item)).toBe("accepted");
  });

  test("accepts Claude's Bash that succeeded, as exit 0", () => {
    expect(outcome(claude("Bash", { stdout: "3 pass", stderr: "" }))).toBe("accepted");
  });

  test.each([
    ["failed", "failed" as const, { stdout: "1 fail", stderr: "" }],
    ["moved to the background", "completed" as const, { stdout: "", backgroundTaskId: "b1" }],
    ["was interrupted", "completed" as const, { stdout: "1 pass", interrupted: true }],
    [
      "exited non-zero without an error",
      "completed" as const,
      { stdout: "", stderr: "", returnCodeInterpretation: "No matches found" },
    ],
    ["has no Bash result", "completed" as const, null],
  ])("refuses Claude's Bash that %s, which carries no exit code", (_, status, structured) => {
    expect(outcome(claude("Bash", structured, status))).toBe("E-RECEIPT-UNKNOWN");
  });

  test("refuses Claude's Bash started in the background", () => {
    const item = claudeToolItem({
      id: "check",
      name: "Bash",
      input: { command: "bun test", run_in_background: true },
      cwd: "/repo",
      status: "completed",
      resultText: null,
      structured: { stdout: "", stderr: "" },
    });

    expect(outcome(item)).toBe("E-RECEIPT-UNKNOWN");
  });
});
