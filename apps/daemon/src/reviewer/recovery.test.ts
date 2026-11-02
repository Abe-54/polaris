import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  DomainEvent,
  LayerRun,
  ReviewerRun,
  RiskSummary,
  RiskSummaryId,
  RiskSummaryKey,
  RiskSummaryLayers,
  RiskSummaryRef,
  ReviewSubject,
  SessionId,
  WorkspaceId,
} from "@polaris/protocol";
import { Effect, Layer } from "effect";
import { EventStore } from "../store/EventStore.ts";
import { recoverReviewer, RESTART_NOTE } from "./recovery.ts";
import { ReviewerSessions } from "./sessions.ts";
import { tempDir } from "../platform/tempDir.testing.ts";

const summary = (id: string, status: "running" | "completed", sessionId: SessionId | null) =>
  RiskSummary.make({
    id: RiskSummaryId.make(id),
    key: RiskSummaryKey.make({ repo: "repo", mergeBase: "base", head: id, since: null }),
    workspaceId: WorkspaceId.make("workspace"),
    subject: ReviewSubject.cases.SessionTurns.make({
      sessionId: SessionId.make("author"),
      firstTurnId: null,
      lastTurnId: null,
    }),
    checkoutId: null,
    status,
    layers: RiskSummaryLayers.make({
      rules: LayerRun.make({ status: "completed", note: null }),
      agent: LayerRun.make({ status, note: null }),
    }),
    reviewer: ReviewerRun.make({
      harness: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
      sessionId,
    }),
    findings: [],
    cost: null,
    note: null,
    startedAt: new Date(0).toISOString(),
    endedAt: null,
  });

test("a restarted Reviewer fails abandoned summaries, keeps completed layers, and restores durable session identities", async () => {
  const dir = tempDir("rvfix-recovery-", { short: true });
  const filename = join(dir, "state.sqlite");
  const done = summary("done", "completed", SessionId.make("old-reviewer"));
  const abandoned = summary("abandoned", "running", null);
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* EventStore;
      yield* store.commit({
        commandId: null,
        decide: () =>
          Effect.succeed([
            DomainEvent.cases.RiskSummaryStarted.make({ summary: done }),
            DomainEvent.cases.RiskSummaryStarted.make({ summary: abandoned }),
          ]),
      });
    }).pipe(Effect.provide(EventStore.layerSqlite(filename)))
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* EventStore;
      yield* recoverReviewer;

      const restored = yield* store.review.riskSummary(
        RiskSummaryRef.cases.ById.make({ summaryId: abandoned.id })
      );

      expect(restored).toMatchObject({
        status: "failed",
        note: RESTART_NOTE,
        layers: { rules: { status: "completed" }, agent: { status: "failed", note: RESTART_NOTE } },
      });
      expect(restored?.endedAt).not.toBeNull();
      expect((yield* ReviewerSessions).has(SessionId.make("old-reviewer"))).toBe(true);
      expect(
        yield* store.review.riskSummary(RiskSummaryRef.cases.ById.make({ summaryId: done.id }))
      ).toEqual(done);
      const sequence = (yield* store.model).sequence;
      yield* recoverReviewer;
      expect((yield* store.model).sequence).toBe(sequence);
    }).pipe(
      Effect.provide(Layer.mergeAll(EventStore.layerSqlite(filename), ReviewerSessions.layer))
    )
  );
});
