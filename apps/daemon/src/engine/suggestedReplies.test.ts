import { expect, test } from "bun:test";
import {
  AgentSession,
  DomainEvent,
  HarnessAvailability,
  HostHarnesses,
  SessionId,
  SuggestedReply,
  SuggestedReplySettings,
  Turn,
  TurnId,
  WorkspaceId,
} from "@polaris/protocol";
import { foldSession, type SessionRecord } from "../store/model.ts";
import { patchTurn } from "../store/patch.ts";
import { suggestReply } from "./suggestedReplies.ts";
import { resolveFallback } from "./suggestedReplyPreference.ts";

const at = "2026-11-10T00:00:00.000Z";

const sessionId = SessionId.make("s-1");

const session = new AgentSession({
  id: sessionId,
  workspaceId: WorkspaceId.make("ws-1"),
  harness: "codex",
  title: "t",
  cwd: "/repo",
  worktreeId: null,
  state: "idle",
  permissionMode: "supervised",
  model: null,
  effort: null,
  parentSessionId: null,
  forkedFromTurnId: null,
  harnessCursor: null,
  turnCount: 0,
  contextUsage: null,
  lastError: null,
  createdAt: at,
  updatedAt: at,
});

const turn = (id: string, index: number) =>
  new Turn({
    id: TurnId.make(id),
    sessionId,
    index,
    prompt: id,
    trigger: null,
    attachments: [],
    model: null,
    effort: null,
    status: "completed",
    checkpointBefore: null,
    checkpointAfter: null,
    startedAt: at,
    endedAt: at,
  });

const started = (t: Turn) => DomainEvent.cases.TurnStarted.make({ turn: t });

const suggested = (t: Turn, text: string) =>
  DomainEvent.cases.SessionReplySuggested.make({
    sessionId,
    reply: SuggestedReply.make({ turnId: t.id, text, source: "polaris" }),
  });

const fold = (events: ReadonlyArray<DomainEvent>): SessionRecord =>
  foldSession(
    sessionId,
    undefined,
    [DomainEvent.cases.SessionCreated.make({ session }), ...events],
    at
  )!;

const [t1, t2] = [turn("t1", 0), turn("t2", 1)];

test("the fold keeps a suggestion until a newer Turn starts", () => {
  expect(fold([started(t1), suggested(t1, "Ship it")]).session.suggestedReply?.text).toBe(
    "Ship it"
  );
  expect(
    fold([started(t1), suggested(t1, "Ship it"), started(t2)]).session.suggestedReply
  ).toBeNull();
});

test("a suggestion that arrives after a newer Turn started folds to none", () => {
  expect(fold([started(t1), started(t2), suggested(t1, "Late")]).session.suggestedReply).toBeNull();
});

test("the decision offers trimmed text once, for the latest ended Turn only", () => {
  const record = fold([started(t1), started(t2)]);
  const [event] = suggestReply(record, t2.id, "  Next step  ", "harness");

  expect(event).toMatchObject({ reply: { turnId: t2.id, text: "Next step", source: "harness" } });
  expect(suggestReply(record, t2.id, "   ", "harness")).toEqual([]);

  const offered = fold([started(t2), suggested(t2, "Again")]);

  expect(suggestReply(offered, t2.id, "Again", "polaris")).toEqual([]);
  expect(suggestReply(fold([]), t1.id, "No Turn yet", "harness")).toEqual([]);
});

test("a suggestion written for a Turn that is no longer latest, or still running, commits nothing", () => {
  const later = fold([started(t1), started(t2)]);
  const running = fold([started(t1), started(patchTurn(t2, { status: "working", endedAt: null }))]);

  expect(suggestReply(later, t1.id, "Late", "polaris")).toEqual([]);
  expect(suggestReply(running, t2.id, "Too early", "harness")).toEqual([]);
});

const ready = (...kinds: ReadonlyArray<string>) =>
  HostHarnesses.make({
    checkedAt: at,
    harnesses: kinds.map((harness) =>
      HarnessAvailability.make({
        harness,
        status: "ready",
        version: "1.0.0",
        minVersion: "1.0.0",
        olderThanTested: null,
        signInKind: null,
        detail: null,
        signInArgv: null,
      })
    ),
  });

test("an unset fallback picks Codex's small model, then Claude Haiku, by what is ready", () => {
  const unset = SuggestedReplySettings.make({});

  expect(resolveFallback(unset, ready("claude", "codex")).choice?.model).toBe("gpt-6-luna");
  expect(resolveFallback(unset, ready("claude")).choice?.model).toBe("claude-haiku-5-5");
  expect(resolveFallback(unset, ready()).choice).toBeNull();
});
