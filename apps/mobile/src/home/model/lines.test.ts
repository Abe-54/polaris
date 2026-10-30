import { expect, test } from "bun:test";
import type { DaemonClient } from "@polaris/client/rpc";
import {
  ApprovalDecision,
  ApprovalQuestion,
  ApprovalRequest,
  type Command,
  QuestionOption,
} from "@polaris/protocol";
import { Effect } from "effect";
import { commandApproval, question, session } from "../fixtures.testing.ts";
import type { SessionRow } from "./home.ts";
import { approvalDetail, quickQuestion, statusLine } from "./lines.ts";
import { type Reply, respond } from "./respond.ts";

const row = (
  input: Parameters<typeof session>[0],
  replyPreview: string | null = null
): SessionRow => ({
  kind: "session",
  key: input.id,
  hostId: "h1",
  hostName: "Linux VM",
  workspaceName: "polaris",
  session: session(input),
  approval: null,
  replyPreview,
  since: 0,
  stale: false,
});

test.each([
  [
    { id: "a", state: "working", turnCount: 6 },
    "Running bun test\nmore",
    true,
    "Running bun test · turn 6 · Linux VM",
  ],
  [{ id: "b", state: "working", turnCount: 2 }, null, false, "Working · turn 2"],
  [
    { id: "c", state: "idle", turnCount: 3, acceptedThroughIndex: 1 },
    null,
    false,
    "Ready to review · turn 3",
  ],
  [{ id: "d", state: "idle", turnCount: 3, acceptedThroughIndex: 2 }, null, false, "Idle · turn 3"],
  [
    { id: "e", state: "failed", lastError: "Codex exited\ntrace" },
    null,
    false,
    "Failed · Codex exited",
  ],
] as const)("%p says %p", (input, preview, withHost, text) => {
  expect(statusLine(row(input, preview), withHost).text).toBe(text);
});

test("a failed agent session's line is in the failed colour", () => {
  expect(statusLine(row({ id: "f", state: "failed" }), false).tone).toBe("failed");
});

test("a command reads as a shell line", () => {
  expect(approvalDetail(commandApproval("s", "r", "cargo build --release"))).toEqual({
    text: "$ cargo build --release",
    tooLong: false,
  });
});

test.each([
  ["a command of many lines", "echo ok\nrm -rf ~/a\nrm -rf ~/b\nrm -rf ~/c\nrm -rf ~/d"],
  ["a very long command", `curl ${"x".repeat(400)}`],
])("%s is never approved from its first line", (_, command) => {
  const detail = approvalDetail(commandApproval("s", "r", command));

  expect(detail?.text).toBe(`$ ${command}`);
  expect(detail?.tooLong).toBe(true);
});

test("only a single single-choice question is answered with chips", () => {
  const single = question("s", "r", "Monthly or annually?", ["Annual", "Monthly"]);

  const multi = new ApprovalQuestion({
    header: "",
    question: "Which?",
    options: [new QuestionOption({ label: "A", description: null })],
    multiSelect: false,
  });

  const twoQuestions = new ApprovalRequest({
    id: single.id,
    sessionId: single.sessionId,
    turnId: single.turnId,
    kind: "question",
    title: "Two questions",
    detail: null,
    options: [],
    questions: [multi, multi],
    openedAt: single.openedAt,
  });

  expect(quickQuestion(single)?.choices).toEqual(["Annual", "Monthly"]);
  expect(quickQuestion(twoQuestions)).toBeNull();
});

const sent = async (reply: Reply) => {
  let command: Command | null = null;

  const dispatch = (payload: { readonly command: Command }) =>
    Effect.sync(() => {
      command = payload.command;

      return { sequence: null };
    });
  // SAFETY: respond dispatches without `discard`, so the reply is `{ sequence }` as here.

  const dispatchOnly = { dispatch: dispatch as DaemonClient["dispatch"] };
  // SAFETY: respond calls only dispatch; nothing else on the client is touched.
  const client = dispatchOnly as DaemonClient;

  await Effect.runPromise(respond(client, question("s", "r", "Which?", ["Annual"]), reply));

  return command;
};

test.each([
  [{ kind: "approve" }, ApprovalDecision.cases.Allow.make({ remember: false })],
  [{ kind: "always" }, ApprovalDecision.cases.Allow.make({ remember: true })],
  [{ kind: "deny" }, ApprovalDecision.cases.Deny.make({ reason: null })],
  [
    { kind: "answer", text: "Annual" },
    ApprovalDecision.cases.Answer.make({ text: "Annual", answers: [["Annual"]] }),
  ],
] as const)("%p reaches the Daemon as %p", async (reply, decision) => {
  const command = await sent(reply);

  expect(command).toMatchObject({ requestId: "r", decision });
});
