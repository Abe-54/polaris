import { describe, expect, test } from "bun:test";
import {
  Command,
  DomainEvent,
  LayerRun,
  ReviewerChoice,
  ReviewerSettings,
  ReviewerRun,
  ReviewSubject,
  RiskSummary,
  RiskSummaryId,
  RiskSummaryKey,
  RiskSummaryLayers,
  RiskSummaryRef,
  SessionId,
  WorkspaceId,
} from "@polaris/protocol";
import { Effect, Schema, Stream } from "effect";
import { Engine } from "../engine/Engine.ts";
import { EventStore } from "../store/EventStore.ts";
import { foldRiskSummary } from "../store/review.ts";
import {
  changeWalkthrough,
  initialWalkthrough,
  recoverWalkthroughs,
  requestWalkthroughs,
  stopWalkthroughs,
  storeWalkthrough,
  walkthroughChoice,
  walkthroughKey,
} from "./walkthrough.ts";
import { recoverReviewer, RESTART_NOTE } from "./recovery.ts";
import { ReviewerSessions } from "./sessions.ts";
import { walkthroughProblem } from "./walkthroughPrompt.ts";

const choice = ReviewerChoice.make({ harness: "claude", model: "model", effort: "high" });

const initial = initialWalkthrough("head", choice, {
  off: false,
  waiting: false,
  lines: 1,
  files: 1,
});

const summary = RiskSummary.make({
  id: RiskSummaryId.make("summary"),
  key: RiskSummaryKey.make({ repo: "/repo", mergeBase: "base", head: "head", since: null }),
  workspaceId: WorkspaceId.make("ws"),
  subject: ReviewSubject.cases.SessionTurns.make({
    sessionId: SessionId.make("user"),
    firstTurnId: null,
    lastTurnId: null,
  }),
  checkoutId: null,
  status: "completed",
  layers: RiskSummaryLayers.make({
    rules: LayerRun.make({ status: "completed", note: null }),
    agent: LayerRun.make({ status: "completed", note: "Findings preserved" }),
  }),
  reviewer: null,
  cost: null,
  note: null,
  findings: [],
  startedAt: "2026-10-01T00:00:00Z",
  endedAt: "2026-10-01T00:00:01Z",
  walkthrough: initial,
});

const run = <A, E>(work: Effect.Effect<A, E, EventStore>) =>
  Effect.runPromise(work.pipe(Effect.provide(EventStore.layerSqlite(":memory:"))));

const seed = Effect.gen(function* () {
  const store = yield* EventStore;

  yield* store.commit({
    commandId: null,
    decide: () => Effect.succeed([DomainEvent.cases.RiskSummaryStarted.make({ summary })]),
  });
});

const read = Effect.flatMap(EventStore, (store) =>
  store.review.riskSummary(RiskSummaryRef.cases.ById.make({ summaryId: summary.id }))
);

describe("walkthrough persistence and controls", () => {
  test("metadata never replaces the Reviewer layer, and later layer events retain it", () => {
    const ready = changeWalkthrough(initial, { state: "ready", markdown: "saved" });

    const metadata = DomainEvent.cases.RiskSummaryLayerChanged.make({
      summaryId: summary.id,
      layer: "agent",
      run: LayerRun.make({ status: "pending", note: null }),
      walkthrough: ready,
    });

    const changed = foldRiskSummary(summary, metadata, summary.startedAt);
    expect(changed?.layers.agent).toEqual(summary.layers.agent);
    expect(changed?.walkthrough?.markdown).toBe("saved");

    const next = foldRiskSummary(
      changed,
      DomainEvent.cases.RiskSummaryLayerChanged.make({
        summaryId: summary.id,
        layer: "agent",
        run: LayerRun.make({ status: "failed", note: "review failed" }),
      }),
      summary.startedAt
    );

    expect(next?.walkthrough?.markdown).toBe("saved");
  });

  test("older Clients ignore optional metadata and the new decoder accepts old summaries", () => {
    const {
      walkthrough: _walkthrough,
      deltaWalkthrough: _delta,
      prompts: _prompts,
      ...oldFields
    } = RiskSummary.fields;

    const legacy = Schema.Struct(oldFields);
    const wire = Schema.encodeSync(RiskSummary)(summary);
    const old = Schema.decodeUnknownSync(legacy)(wire);
    expect("walkthrough" in old).toBe(false);
    expect(Schema.decodeUnknownSync(RiskSummary)(old).walkthrough).toBeUndefined();

    const legacyEvent = Schema.Struct({
      _tag: Schema.Literal("RiskSummaryLayerChanged"),
      summaryId: RiskSummaryId,
      layer: Schema.Literal("agent"),
      run: LayerRun,
    });

    const event = DomainEvent.cases.RiskSummaryLayerChanged.make({
      summaryId: summary.id,
      layer: "agent",
      run: summary.layers.agent,
      walkthrough: initial,
    });

    expect(Schema.decodeUnknownSync(legacyEvent)(event).run).toEqual(summary.layers.agent);
  });

  test("restart preserves partial Markdown and requires Retry without starting a session", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        yield* storeWalkthrough(
          summary,
          changeWalkthrough(initial, { markdown: "## Why the change\nPartial" }),
          false
        );
        yield* recoverWalkthroughs();
        const failed = yield* read;
        expect(failed?.walkthrough).toMatchObject({
          state: "failed",
          markdown: "## Why the change\nPartial",
        });
        expect(failed?.walkthrough?.reason).toContain("Daemon restarted");
        expect((yield* (yield* EventStore).model).sessions.size).toBe(0);
        const retry = yield* requestWalkthroughs(failed!, choice, new Set());
        expect(retry.walkthrough?.state).toBe("writing");
        expect(retry.deltaWalkthrough).toBeUndefined();
      })
    );
  });

  test("Reviewer recovery and walkthrough recovery preserve each other's state", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* EventStore;

        const abandoned = RiskSummary.make({
          id: summary.id,
          key: summary.key,
          workspaceId: summary.workspaceId,
          subject: summary.subject,
          checkoutId: summary.checkoutId,
          cost: summary.cost,
          note: summary.note,
          findings: summary.findings,
          startedAt: summary.startedAt,
          endedAt: null,
          status: "running",
          layers: RiskSummaryLayers.make({
            rules: summary.layers.rules,
            agent: LayerRun.make({ status: "running", note: null }),
          }),
          reviewer: ReviewerRun.make({
            harness: "claude",
            model: "model",
            effort: "high",
            sessionId: SessionId.make("durable-reviewer"),
          }),
          walkthrough: changeWalkthrough(initial, {
            markdown: "## Why the change\nPartial",
            sessionId: SessionId.make("walkthrough"),
          }),
        });

        yield* store.commit({
          commandId: null,
          decide: () =>
            Effect.succeed([DomainEvent.cases.RiskSummaryStarted.make({ summary: abandoned })]),
        });

        yield* recoverReviewer.pipe(Effect.provide(ReviewerSessions.layer));
        const reviewRecovered = (yield* read)!;
        expect(reviewRecovered.status).toBe("failed");
        expect(reviewRecovered.layers.agent.note).toBe(RESTART_NOTE);
        expect(reviewRecovered.walkthrough?.state).toBe("writing");
        yield* recoverWalkthroughs();
        const recovered = (yield* read)!;
        expect(recovered.layers.rules.status).toBe("completed");
        expect(recovered.layers.agent.note).toBe(RESTART_NOTE);
        expect(recovered.walkthrough?.state).toBe("failed");
        expect(recovered.walkthrough?.markdown).toBe("## Why the change\nPartial");
        expect(recovered.walkthrough?.sessionId).toBe(SessionId.make("walkthrough"));
        expect((yield* store.review.recovery).sessions).toContain(
          SessionId.make("durable-reviewer")
        );
      })
    );
  });

  test("Stop dispatches Interrupt and persists its reason; active work and ready heads are shared", async () => {
    const commands: Array<Command> = [];

    const engine = Engine.of({
      recoveredTurns: [],
      runCommittedTurn: () => Effect.void,
      canSteerSession: () => Effect.succeed(false),
      steerCommittedInput: () => Effect.void,
      retireLead: () => Effect.void,
      dispatch: (input) =>
        Effect.sync(() => {
          commands.push(input.command);

          return { sequence: null };
        }),
      requestSecret: () => Effect.die("unused"),
      provideSecret: () => Effect.die("unused"),
      subscribeHost: () => Stream.empty,
      subscribeSession: () => Stream.empty,
      readTurnPage: () => Effect.die("unused"),
      hasSession: () => Effect.succeed(true),
      hostableSession: () => Effect.succeed(true),
      terminalCommand: () => Effect.succeed(null),
      prepareForUpgrade: Effect.void,
      prepareForRestart: Effect.void,
      autoArchiveSettings: Effect.die("unused"),
      setAutoArchiveSettings: () => Effect.die("unused"),
      idleCompactionSettings: Effect.die("unused"),
      setIdleCompactionSettings: () => Effect.die("unused"),
      checkoutStatus: () => Effect.die("unused"),
      checkoutReviewed: () => Effect.void,
    });

    await run(
      Effect.gen(function* () {
        yield* seed;
        const value = changeWalkthrough(initial, { sessionId: SessionId.make("writer") });
        yield* storeWalkthrough(summary, value, false);
        const writing = (yield* read)!;
        const active = new Set([walkthroughKey(writing, value, false)]);
        expect((yield* requestWalkthroughs(writing, choice, active)).walkthrough?.sessionId).toBe(
          SessionId.make("writer")
        );
        yield* stopWalkthroughs(writing).pipe(Effect.provideService(Engine, engine));
        expect(commands).toHaveLength(1);
        expect(Command.guards.Interrupt(commands[0]!)).toBe(true);
        expect((yield* read)?.walkthrough?.reason).toBe("The walkthrough was stopped.");
        yield* storeWalkthrough(summary, changeWalkthrough(value, { state: "ready" }), false);
        expect(
          (yield* requestWalkthroughs((yield* read)!, choice, new Set())).walkthrough?.sessionId
        ).toBe(SessionId.make("writer"));
      })
    );
  });

  test("older settings default to the Reviewer; explicit walkthrough choices override fields", () => {
    const old = Schema.decodeUnknownSync(ReviewerSettings)({ default: null, workspaces: {} });
    expect(old.walkthrough).toBeUndefined();
    expect(walkthroughChoice(old, choice)).toEqual(choice);

    const separate = Schema.decodeUnknownSync(ReviewerSettings)({
      default: null,
      workspaces: {},
      walkthrough: { enabled: true, harness: "codex", model: null, effort: "low" },
    });

    expect(walkthroughChoice(separate, choice)).toMatchObject({
      harness: "codex",
      model: "model",
      effort: "low",
    });
    expect(walkthroughProblem("A summary without sections")).not.toBeNull();
  });
});
