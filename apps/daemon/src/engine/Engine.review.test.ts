import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type Capability,
  Command,
  DomainEvent,
  FeedbackBatch,
  FeedbackComment,
  feedbackPrompt,
  type HostStreamItem,
  LayerRun,
  LineRange,
  PullRequestRef,
  RepoRef,
  ReviewCheckoutId,
  ReviewSubject,
  RiskFinding,
  RiskFindingId,
  RiskSummary,
  RiskSummaryId,
  RiskSummaryKey,
  RiskSummaryLayers,
  RiskSummaryRef,
  Sequence,
  SessionId,
  SessionPlacement,
  TurnId,
  VerdictId,
  type Workspace,
} from "@polaris/protocol";
import { Effect, Fiber, type Layer, Predicate, Stream } from "effect";
import { EventStore } from "../store/EventStore.ts";
import { watchRiskSummary } from "../review/ReviewRpcs.ts";
import { Engine } from "./Engine.ts";
import {
  cid,
  completesTurns,
  engineLayer,
  fakeRepo,
  makeFakeDriver,
  makeFakes,
  tempDir,
  waitFor,
  waitUntil,
} from "./testing.ts";

type Env = Engine | EventStore;

const run = <A, E>(layer: Layer.Layer<Env>, program: Effect.Effect<A, E, Env>) =>
  Effect.runPromise(program.pipe(Effect.provide(layer)));

const dispatch = (command: Command, deviceLabel = "MacBook") =>
  Effect.flatMap(Engine, (engine) => engine.dispatch({ commandId: cid(), command, deviceLabel }));

const rejection = (command: Command) =>
  Effect.flip(dispatch(command)).pipe(
    Effect.map((error) =>
      Predicate.isTagged(error, "CommandRejected") ? error.reason : error._tag
    )
  );

const setup = () => {
  const claude = makeFakeDriver("claude", { onTurn: completesTurns("c-1") });

  const layer = engineLayer({
    filename: join(tempDir(), "state.sqlite"),
    fakes: makeFakes(),
    drivers: [claude],
  });

  return { claude, layer };
};

const registerWorkspace = Effect.gen(function* () {
  const repo = fakeRepo();
  yield* dispatch(Command.cases.RegisterWorkspace.make({ path: repo, name: null }));

  const model = yield* waitFor((m) => [...m.workspaces.values()].some((w) => w.path === repo));

  return [...model.workspaces.values()].find((w) => w.path === repo)!;
});

const sessionId = SessionId.make("s-review");

/** A session whose first Turn completed (the fake Harness completes every Turn). */
const idleSession = (workspace: Workspace) =>
  Effect.gen(function* () {
    yield* dispatch(
      Command.cases.StartSession.make({
        sessionId,
        workspaceId: workspace.id,
        harness: "claude",
        placement: SessionPlacement.cases.InPlace.make({}),
        permissionMode: "supervised",
        model: null,
        effort: null,
        prompt: "Add the parser",
        attachments: [],
      })
    );

    const model = yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "idle");

    return model.sessions.get(sessionId)!;
  });

const hostEvents = (capabilities: ReadonlyArray<Capability>) =>
  Effect.flatMap(Engine, (engine) =>
    engine.subscribeHost(Sequence.make(0), { capabilities }).pipe(
      Stream.takeUntil((item: HostStreamItem) => Predicate.isTagged(item, "Synchronized")),
      Stream.runCollect
    )
  ).pipe(
    Effect.map((items) =>
      items.flatMap((item) => (Predicate.isTagged(item, "Event") ? [item.envelope.event._tag] : []))
    )
  );

const acceptedEvents = Effect.flatMap(Engine, (engine) =>
  engine.subscribeHost(Sequence.make(0), { capabilities: ["session.accept"] }).pipe(
    Stream.takeUntil((item: HostStreamItem) => Predicate.isTagged(item, "Synchronized")),
    Stream.runCollect
  )
).pipe(
  Effect.map((items) =>
    items.flatMap((item) =>
      Predicate.isTagged(item, "Event") && Predicate.isTagged(item.envelope.event, "TurnsAccepted")
        ? [item.envelope.event]
        : []
    )
  )
);

const hostSnapshot = (capabilities: ReadonlyArray<Capability>) =>
  Effect.flatMap(Engine, (engine) =>
    engine.subscribeHost(null, { capabilities }).pipe(Stream.take(1), Stream.runCollect)
  ).pipe(
    Effect.map((items) => {
      const first = items[0];

      return Predicate.isTagged(first, "Snapshot") ? first : null;
    })
  );

describe("feedback and accepting Turns", () => {
  test("SendFeedback sends one Turn with the batch quoted, and records the batch", async () => {
    const { claude, layer } = setup();
    await run(
      layer,
      Effect.gen(function* () {
        const workspace = yield* registerWorkspace;
        yield* idleSession(workspace);

        const feedback = new FeedbackBatch({
          message: "A few things:",
          comments: [
            new FeedbackComment({
              id: "c1",
              path: "src/parse.ts",
              lines: new LineRange({ start: 3, end: 4, side: "new" }),
              code: "if (x) {\n  return;",
              note: "Handle the empty case",
              findingId: null,
            }),
          ],
        });

        yield* dispatch(Command.cases.SendFeedback.make({ sessionId, feedback, attachments: [] }));

        const model = yield* waitFor((m) => m.sessions.get(sessionId)?.session.turnCount === 2);
        const turn = model.sessions.get(sessionId)!.turns[1]!;
        expect(turn.feedback).toEqual(feedback);
        expect(turn.prompt).toBe(feedbackPrompt(feedback));
        yield* waitUntil(() => claude.latest(sessionId)?.turns.length === 2);
        expect(claude.latest(sessionId)?.turns.at(-1)?.prompt).toBe(feedbackPrompt(feedback));

        const empty = new FeedbackBatch({ message: " ", comments: [] });
        expect(
          yield* rejection(
            Command.cases.SendFeedback.make({ sessionId, feedback: empty, attachments: [] })
          )
        ).toBe("the feedback is empty");
      })
    );
  });

  test("AcceptTurns moves forward only, between Turns, and older Clients never see it", async () => {
    const { layer } = setup();
    await run(
      layer,
      Effect.gen(function* () {
        const workspace = yield* registerWorkspace;
        const record = yield* idleSession(workspace);
        const first = record.turns[0]!;

        const accept = (revertLaterTurns = false) =>
          Command.cases.AcceptTurns.make({
            sessionId,
            throughTurnId: first.id,
            revertLaterTurns,
          });

        const accepted = yield* dispatch(accept());
        expect(accepted.sequence).not.toBeNull();

        const store = yield* EventStore;
        expect((yield* store.model).sessions.get(sessionId)?.session.acceptedThroughIndex).toBe(0);

        // Accepting the same Turn again records nothing.
        expect((yield* dispatch(accept())).sequence).toBeNull();

        yield* dispatch(
          Command.cases.SendTurn.make({ sessionId, prompt: "And the tests", attachments: [] })
        );

        const model = yield* waitFor(
          (m) =>
            m.sessions.get(sessionId)?.session.turnCount === 2 &&
            m.sessions.get(sessionId)?.session.state === "idle"
        );

        const second = model.sessions.get(sessionId)!.turns[1]!;

        yield* dispatch(
          Command.cases.AcceptTurns.make({
            sessionId,
            throughTurnId: second.id,
            revertLaterTurns: false,
          })
        );
        expect(yield* rejection(accept())).toBe("the Turns through Turn 2 are already accepted");
        expect((yield* store.model).sessions.get(sessionId)?.session.acceptedThroughUserTurn).toBe(
          2
        );
        // Clients fold the user Turn from the event, as they can't see the Turn it names.
        expect((yield* acceptedEvents).map((e) => e.throughUserTurn)).toEqual([1, 2]);

        const pullRequest = new PullRequestRef({
          repo: new RepoRef({ host: "github.com", owner: "acme", name: "app" }),
          number: 7,
        });

        yield* dispatch(Command.cases.LinkPullRequest.make({ sessionId, pullRequest }));
        expect((yield* store.model).sessions.get(sessionId)?.session.pullRequest).toEqual(
          pullRequest
        );

        expect(yield* hostEvents([])).not.toContain("TurnsAccepted");
        expect(yield* hostEvents(["session.accept"])).toContain("TurnsAccepted");
      })
    );
  });

  test("AcceptTurns names a Turn of the session", async () => {
    const { layer } = setup();
    await run(
      layer,
      Effect.gen(function* () {
        const workspace = yield* registerWorkspace;
        yield* idleSession(workspace);

        const missing = yield* Effect.flip(
          dispatch(
            Command.cases.AcceptTurns.make({
              sessionId,
              throughTurnId: TurnId.make("nope"),
              revertLaterTurns: false,
            })
          )
        );

        expect(missing._tag).toBe("NotFound");
      })
    );
  });
});

describe("Review Checkouts", () => {
  const checkoutId = ReviewCheckoutId.make("rc-1");

  const subject = ReviewSubject.cases.PullRequest.make({
    pullRequest: new PullRequestRef({
      repo: new RepoRef({ host: "github.com", owner: "acme", name: "app" }),
      number: 42,
    }),
    baseRef: "main",
  });

  const open = (workspace: Workspace, head: string | null = "h1") =>
    Command.cases.OpenReviewCheckout.make({
      checkoutId,
      workspaceId: workspace.id,
      subject,
      head,
      base: "b1",
    });

  test("open, report a head, remove; refusals say why", async () => {
    const { layer } = setup();
    await run(
      layer,
      Effect.gen(function* () {
        const workspace = yield* registerWorkspace;
        const store = yield* EventStore;

        expect(yield* rejection(open(workspace, null))).toBe(
          "a pull request's Review Checkout needs its head and base commits"
        );

        yield* dispatch(open(workspace));
        const checkout = (yield* store.model).reviewCheckouts.get(checkoutId)!;
        expect(checkout.state).toBe("fetching");
        expect(checkout.path).toBe(join(workspace.worktreeRoot, ".review", "pr-42"));
        expect(checkout.latestHead).toBe("h1");

        expect(yield* rejection(open(workspace))).toBe("Review Checkout rc-1 is already open");

        const sameHead = Command.cases.ReportReviewHead.make({
          checkoutId,
          head: "h1",
          base: "b1",
        });

        expect((yield* dispatch(sameHead)).sequence).toBeNull();

        yield* dispatch(
          Command.cases.ReportReviewHead.make({ checkoutId, head: "h2", base: "b1" })
        );
        expect((yield* store.model).reviewCheckouts.get(checkoutId)?.latestHead).toBe("h2");

        yield* dispatch(Command.cases.RemoveReviewCheckout.make({ checkoutId, reason: "merged" }));
        expect((yield* store.model).reviewCheckouts.get(checkoutId)?.state).toBe("removing");
        expect(
          yield* rejection(
            Command.cases.UpdateReviewCheckout.make({ checkoutId, discardChanges: false })
          )
        ).toBe("the Review Checkout is being removed");

        expect((yield* hostSnapshot([]))?.reviewCheckouts).toEqual([]);
        expect((yield* hostSnapshot(["review.checkouts"]))?.reviewCheckouts.length).toBe(1);
        expect(yield* hostEvents([])).not.toContain("ReviewCheckoutOpened");
        expect(yield* hostEvents(["review.checkouts"])).toContain("ReviewCheckoutOpened");
      })
    );
  });
});

describe("Risk Summaries and Verdicts", () => {
  const summaryId = RiskSummaryId.make("sum-1");
  const findingId = RiskFindingId.make("f-1");

  const finding = new RiskFinding({
    id: findingId,
    identity: "id-1",
    source: "rule",
    ruleId: "secrets/aws-key",
    path: "src/config.ts",
    lines: new LineRange({ start: 4, end: 4, side: "new" }),
    severity: "critical",
    confidence: 1,
    title: "AWS key committed",
    reason: "A live-looking access key is in the diff.",
    suggestion: null,
    status: "open",
    resolution: null,
  });

  const started = (workspace: Workspace, id = summaryId, since: string | null = null) =>
    new RiskSummary({
      id,
      key: new RiskSummaryKey({
        repo: "github.com/acme/app",
        mergeBase: "m",
        head: "h",
        since,
      }),
      workspaceId: workspace.id,
      subject: ReviewSubject.cases.SessionTurns.make({
        sessionId,
        firstTurnId: null,
        lastTurnId: null,
      }),
      checkoutId: null,
      status: "running",
      layers: new RiskSummaryLayers({
        rules: new LayerRun({ status: "running", note: null }),
        agent: new LayerRun({ status: "pending", note: null }),
      }),
      reviewer: null,
      cost: null,
      note: null,
      findings: [],
      startedAt: "2026-10-01T00:00:00.000Z",
      endedAt: null,
    });

  /** What the Rules and Reviewer modules commit: Daemon events, no command. */
  const record = (...events: ReadonlyArray<DomainEvent>) =>
    Effect.flatMap(EventStore, (store) =>
      store.commit({ commandId: null, decide: () => Effect.succeed(events) })
    );

  const verdict = (thumb: "up" | "down", reasons: ReadonlyArray<"intended" | "other"> = []) =>
    Command.cases.RecordVerdict.make({
      verdictId: VerdictId.make(`v-${thumb}-${reasons.length}`),
      summaryId,
      findingId,
      thumb,
      reasons,
      text: null,
      scope: "repo",
    });

  test("a summary folds in SQL; Verdicts dismiss and reopen; neither is on the Host stream", async () => {
    const { layer } = setup();
    await run(
      layer,
      Effect.gen(function* () {
        const workspace = yield* registerWorkspace;
        const store = yield* EventStore;
        const byId = RiskSummaryRef.cases.ById.make({ summaryId });

        yield* record(DomainEvent.cases.RiskSummaryStarted.make({ summary: started(workspace) }));
        yield* record(
          DomainEvent.cases.RiskFindingsRecorded.make({ summaryId, findings: [finding] })
        );
        yield* record(
          DomainEvent.cases.RiskSummaryLayerChanged.make({
            summaryId,
            layer: "rules",
            run: new LayerRun({ status: "completed", note: null }),
          })
        );

        const summary = yield* store.review.riskSummary(byId);
        expect(summary?.findings.map((f) => f.status)).toEqual(["open"]);
        expect(summary?.layers.rules.status).toBe("completed");
        expect(
          yield* store.review.riskSummary(RiskSummaryRef.cases.ByKey.make({ key: summary!.key }))
        ).toEqual(summary);

        // An incremental summary at the same head: `LatestAt` answers it, `ByKey` still the full one.
        const incremental = started(workspace, RiskSummaryId.make("sum-2"), "h0");
        yield* record(DomainEvent.cases.RiskSummaryStarted.make({ summary: incremental }));

        const latestAt = RiskSummaryRef.cases.LatestAt.make({
          repo: "github.com/acme/app",
          head: "h",
        });

        expect((yield* store.review.riskSummary(latestAt))?.id).toBe(RiskSummaryId.make("sum-2"));
        expect(
          (yield* store.review.riskSummary(RiskSummaryRef.cases.ByKey.make({ key: summary!.key })))
            ?.id
        ).toBe(summaryId);
        expect(
          yield* store.review.riskSummary(
            RiskSummaryRef.cases.LatestAt.make({ repo: "github.com/acme/app", head: "other" })
          )
        ).toBeNull();

        expect(yield* rejection(verdict("down"))).toBe("a thumbs-down needs a reason");
        yield* dispatch(verdict("down", ["intended"]), "Studio");
        expect((yield* store.review.riskSummary(byId))?.findings[0]?.status).toBe("dismissed");

        const [latest] = yield* store.review.verdicts({
          repo: "github.com/acme/app",
          summaryId: null,
          identity: null,
          limit: 10,
        });

        expect(latest?.finding.identity).toBe("id-1");
        expect(latest?.recordedBy).toBe("Studio");

        yield* dispatch(verdict("up"));
        expect((yield* store.review.riskSummary(byId))?.findings[0]?.status).toBe("open");

        yield* record(
          DomainEvent.cases.RiskFindingResolved.make({
            summaryId,
            findingId,
            resolution: "withdrawn",
            note: null,
          }),
          DomainEvent.cases.RiskSummaryEnded.make({
            summaryId,
            status: "completed",
            reviewer: null,
            cost: null,
            note: "Rules only: no Reviewer is available",
          })
        );
        const ended = yield* store.review.riskSummary(byId);
        expect(ended?.status).toBe("completed");
        expect(ended?.findings[0]?.resolution).toBe("withdrawn");
        expect(ended?.note).toBe("Rules only: no Reviewer is available");

        const tags = yield* hostEvents(["review.verdicts", "review.risk-summary"]);
        expect(tags).not.toContain("VerdictRecorded");
        expect(tags).not.toContain("RiskSummaryStarted");

        const unknown = yield* Effect.flip(
          dispatch({ ...verdict("up"), findingId: RiskFindingId.make("nope") })
        );

        expect(unknown._tag).toBe("NotFound");
      })
    );
  });

  test("watching a summary: the current one, then each change", async () => {
    const { layer } = setup();
    await run(
      layer,
      Effect.gen(function* () {
        const workspace = yield* registerWorkspace;
        const store = yield* EventStore;
        yield* record(DomainEvent.cases.RiskSummaryStarted.make({ summary: started(workspace) }));

        const missing = yield* Effect.flip(
          watchRiskSummary(store, RiskSummaryId.make("nope")).pipe(Stream.runCollect)
        );

        expect(missing._tag).toBe("NotFound");

        const fiber = yield* watchRiskSummary(store, summaryId).pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild
        );

        yield* Effect.sleep("20 millis");
        yield* record(
          DomainEvent.cases.RiskFindingsRecorded.make({ summaryId, findings: [finding] })
        );

        const seen = yield* Fiber.join(fiber);
        expect(seen.map((s) => s.findings.length)).toEqual([0, 1]);
      })
    );
  });
});
