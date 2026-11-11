import { expect, test } from "bun:test";
import { ConstellationId, SessionId, TurnTrigger } from "@polaris/protocol";
import { emptyModel } from "../store/model.ts";
import { HISTORY_MESSAGE_CHARS, HISTORY_MESSAGES, pastMessages } from "./history.ts";
import { agentSession, record, turn } from "./testing.ts";

const mine = SessionId.make("mine");

const other = SessionId.make("other");

const worker = SessionId.make("worker");

const said = (sessionId: SessionId, index: number, prompt: string, extras = {}) =>
  turn(index, "completed", prompt, {
    sessionId,
    startedAt: `2026-11-10T00:00:${String(index).padStart(2, "0")}.000Z`,
    ...extras,
  });

const modelOf = (...records: ReadonlyArray<ReturnType<typeof record>>) => ({
  ...emptyModel,
  sessions: new Map(records.map((r) => [r.session.id, r])),
});

test("the user's typed prompts across their sessions, newest first, without the conversation", () => {
  const current = said(mine, 5, "and the tests?");

  const model = modelOf(
    record(agentSession({ id: mine }), [said(mine, 1, "ship it"), current]),
    record(agentSession({ id: other }), [
      said(other, 2, "lgtm, open the PR"),
      said(other, 3, "! git status", { shellCommand: "git status" }),
      said(other, 4, "/compact", { idleCompaction: true }),
      said(other, 6, "", {
        trigger: TurnTrigger.cases.BackgroundTasksReported.make({ tasks: [] }),
      }),
      said(other, 7, "ship it"),
    ]),
    record(agentSession({ id: worker, worker: { constellationId: ConstellationId.make("c-1") } }), [
      said(worker, 8, "worker brief"),
    ]),
    record(agentSession({ id: SessionId.make("review"), origin: "reviewer" }), [
      said(SessionId.make("review"), 9, "review this diff"),
    ])
  );

  expect(pastMessages(model, new Set([current.id]))).toEqual(["ship it", "lgtm, open the PR"]);
});

test("a long message is cut and its whitespace folded, and at most the cap are kept", () => {
  const turns = Array.from({ length: HISTORY_MESSAGES + 5 }, (_, i) =>
    said(other, i, i === 0 ? `a\n\n${"b".repeat(1000)}` : `message ${i}`)
  );

  const messages = pastMessages(modelOf(record(agentSession({ id: other }), turns)), new Set());

  expect(messages).toHaveLength(HISTORY_MESSAGES);
  expect(messages[0]).toBe(`message ${HISTORY_MESSAGES + 4}`);

  const full = pastMessages(modelOf(record(agentSession({ id: other }), [turns[0]!])), new Set());

  expect(full[0]).toBe(`a ${"b".repeat(HISTORY_MESSAGE_CHARS - 2)}`);
});
