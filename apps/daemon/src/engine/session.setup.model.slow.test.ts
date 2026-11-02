import { expect, test } from "bun:test";
import {
  WorktreeSetupRun,
  ConstellationId,
  TaskId,
  Turn,
  TurnId,
  type AgentSession,
} from "@polaris/protocol";
import fc from "fast-check";
import { decideSession, type SessionInput } from "./session.ts";
import { foldSession, type SessionRecord } from "../store/model.ts";
import { session, WORKER } from "../constellation/delivery/testing.ts";

const AT = "2026-10-02T00:00:00.000Z";

const card = (status: WorktreeSetupRun["status"], id = "setup") =>
  WorktreeSetupRun.make({
    id,
    constellationId: ConstellationId.make("c"),
    taskId: TaskId.make("A"),
    command: "bun install",
    cwd: "/tmp",
    status,
    output: "setup output",
    exitCode: status === "running" ? null : 0,
    startedAt: AT,
    endedAt: status === "running" ? null : AT,
  });

const fresh = (): SessionRecord =>
  foldSession(
    WORKER,
    undefined,
    decideSession(undefined, { type: "session.fork", session: session(WORKER) }).events,
    AT
  )!;

const turn = () =>
  new Turn({
    id: TurnId.make("first"),
    sessionId: WORKER,
    index: 0,
    prompt: "task brief",
    attachments: [],
    model: null,
    effort: null,
    status: "working",
    checkpointBefore: null,
    checkpointAfter: null,
    startedAt: AT,
    endedAt: null,
  });

const setupInput = (status: WorktreeSetupRun["status"]): SessionInput => ({
  type: "session.setup",
  setup: card(status),
});

type Action = "start" | "complete" | "fail" | "restart" | "send";

type Reference = {
  setup: WorktreeSetupRun["status"] | null;
  state: AgentSession["state"];
  turns: number;
  rejected: boolean;
};

const inputs: Record<Action, () => SessionInput> = {
  start: () => setupInput("running"),
  complete: () => setupInput("completed"),
  fail: () => setupInput("failed"),
  restart: () => ({ type: "daemon.recover", cause: "restart", at: AT }),
  send: () => ({ type: "turn.send", turn: turn() }),
};

const recoverReference = (before: Reference): Reference =>
  before.setup === "running"
    ? { ...before, setup: "failed", state: "failed", rejected: false }
    : { ...before, state: before.state === "failed" ? "failed" : "dormant", rejected: false };

const advance = (before: Reference, action: Action): Reference => {
  const next = { ...before, rejected: false };

  switch (action) {
    case "start":
      next.rejected = before.setup === "running";

      if (!next.rejected) next.setup = "running";
      break;
    case "complete":
    case "fail":
      if (before.setup !== "running") break;
      next.setup = action === "complete" ? "completed" : "failed";

      if (action === "fail") next.state = "failed";
      else if (before.state === "failed") next.state = "dormant";
      break;
    case "restart":
      return recoverReference(before);
    case "send":
      next.rejected = before.setup === "running";

      if (next.rejected) break;
      next.turns = 1;
      next.state = before.state === "idle" ? "working" : "starting";
      break;
  }

  return next;
};

test("setup metadata's independent model: running blocks Turns, failure/restart give attention, retries preserve Turn count", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom<Action>("start", "complete", "fail", "restart", "send"), {
        maxLength: 30,
      }),
      (actions) => {
        let record = fresh();
        let expected: Reference = { setup: null, state: "idle", turns: 0, rejected: false };

        for (const action of actions) {
          expected = advance(expected, action);
          const decision = decideSession(record, inputs[action]());
          expect(decision.rejection !== null).toBe(expected.rejected);
          record = foldSession(WORKER, record, decision.events, AT)!;
          expect(record.session.worktreeSetup?.status ?? null).toBe(expected.setup);
          expect(record.session.state).toBe(expected.state);
          expect(record.session.turnCount).toBe(expected.turns);

          if (expected.turns > 0) break;
        }
      }
    ),
    { numRuns: 500 }
  );
});

test("late setup completion preserves the latest card and archived Session State", () => {
  const started = decideSession(fresh(), setupInput("running"));
  const record = foldSession(WORKER, fresh(), started.events, AT)!;

  const archived = foldSession(
    WORKER,
    record,
    decideSession(record, { type: "session.archive", at: AT }).events,
    AT
  )!;

  const done = decideSession(archived, setupInput("failed"));
  const after = foldSession(WORKER, archived, done.events, AT)!;
  expect(after.session.state).toBe("archived");
  expect(after.session.worktreeSetup?.status).toBe("failed");
  const other = card("completed", "old-setup");
  expect(decideSession(record, { type: "session.setup", setup: other }).events).toEqual([]);
});

test("the setup card names what stopped the Daemon: an upgrade, or a Client's Restart daemon", () => {
  const record = foldSession(
    WORKER,
    fresh(),
    decideSession(fresh(), setupInput("running")).events,
    AT
  )!;

  const lastLine = (input: SessionInput) =>
    foldSession(WORKER, record, decideSession(record, input).events, AT)!
      .session.worktreeSetup?.output.split("\n")
      .at(-1);

  expect(lastLine({ type: "daemon.recover", cause: "upgrade", at: AT })).toBe(
    "Setup interrupted by Daemon upgrade. Dispatch again to retry."
  );
  // Restart daemon prepares like an upgrade, but the card says what the user did.
  expect(
    lastLine({ type: "daemon.recover", cause: "upgrade", stoppedFor: "restart", at: AT })
  ).toBe("Setup interrupted by Daemon restart. Dispatch again to retry.");
});
