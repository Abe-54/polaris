/**
 * Bugs the ENG-209 verification work found, kept as regression tests once
 * fixed. A new finding that cannot be fixed in the same change goes here as a
 * `test.todo` (`bun test --todo` runs them). See `packages/spec/README.md`
 * ("Findings").
 */
import { HarnessEvent } from "../harness/HarnessDriver.ts";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { makeFeed, type SequenceMark } from "@polaris/client";
import {
  ApprovalDecision,
  Command,
  CommandRejected,
  HostStreamItem,
  RequestId,
  Sequence,
  SessionId,
  SessionPlacement,
  TurnId,
} from "@polaris/protocol";
import { Effect, type Layer, type Scope, Stream } from "effect";
import { Engine } from "../engine/Engine.ts";
import {
  cid,
  completesTurns,
  engineLayer,
  fakeRepo,
  makeFakeDriver,
  makeFakes,
  tempDir,
  waitFor,
} from "../engine/testing.ts";
import { EventStore } from "../store/EventStore.ts";

type Env = Engine | EventStore;

const run = <A, E>(layer: Layer.Layer<Env>, program: Effect.Effect<A, E, Env | Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(layer)));

const dispatch = (command: Command) =>
  Effect.flatMap(Engine, (engine) =>
    engine.dispatch({ commandId: cid(), command, deviceLabel: "mac" })
  );

const startSession = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const repo = fakeRepo();
    yield* dispatch(Command.cases.RegisterWorkspace.make({ path: repo, name: null }));
    const model = yield* waitFor((m) => m.workspaces.size === 1);
    const workspace = [...model.workspaces.values()][0]!;
    yield* dispatch(
      Command.cases.StartSession.make({
        sessionId,
        workspaceId: workspace.id,
        harness: "claude",
        placement: SessionPlacement.cases.InPlace.make({}),
        permissionMode: "supervised",
        model: null,
        effort: null,
        prompt: "Fix the flaky test",
        attachments: [],
      })
    );
    yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "idle");
  });

const markHost = (item: HostStreamItem): SequenceMark =>
  HostStreamItem.match<SequenceMark>(item, {
    Event: (event) => ({ kind: "event", sequence: event.envelope.sequence }),
    Snapshot: (snapshot) => ({ kind: "snapshot", sequence: snapshot.sequence }),
    Synchronized: (synced) => ({ kind: "synchronized", sequence: synced.sequence }),
  });

/**
 * Finding 1. `HostConnection` opens the host feed with `gapless: true`, but the
 * Daemon's host stream leaves out session-only events (`TurnItemCompleted`,
 * `CheckpointRecorded`), so its sequences have gaps whenever a Turn records an
 * item or a checkpoint. The feed sees the gap, reopens from its last sequence,
 * the replay has the same gap, and it reopens again: the host feed never moves
 * past the first session-only event and resubscribes in a tight loop (thousands
 * of times in a fraction of a second here). Spec: `hostFeedCanProgress` in
 * packages/spec/polaris.qnt (violated in `current`, holds in `fixed`).
 *
 * Fixed: `HostConnection.ts` opens the host feed with `gapless: false` (the
 * dedupe by sequence is enough: a dropped subscriber's stream ends, it is never
 * skipped), and a feed's reopens that make no progress back off.
 */
test("the host feed follows a Turn that records items and checkpoints", async () => {
  const claude = makeFakeDriver("claude", { onTurn: completesTurns() });

  const layer = engineLayer({
    filename: join(tempDir(), "state.sqlite"),
    fakes: makeFakes(),
    drivers: [claude],
  });

  const result = await run(
    layer,
    Effect.gen(function* () {
      const engine = yield* Engine;
      const opens: Array<number | null> = [];

      const feed = yield* makeFeed<Engine["Service"], HostStreamItem, never>({
        source: { next: () => Effect.succeed({ epoch: 1, client: engine }) },
        open: (client, after) => {
          opens.push(after);

          return client.subscribeHost(after === null ? null : Sequence.make(after));
        },
        mark: markHost,
        isDisconnect: () => false,
        gapless: false, // as HostConnection.ts opens it
      });

      yield* Effect.forkScoped(Stream.runDrain(feed.stream));
      yield* Effect.sleep(20);
      yield* startSession(SessionId.make("s1"));

      const model = yield* waitFor(
        (m) => m.sessions.get(SessionId.make("s1"))?.session.state === "idle"
      );

      yield* Effect.sleep(100);

      return { last: feed.lastSequence(), cut: model.sequence, opens: opens.length };
    })
  );

  // Before the fix: last was stuck at the event before the first CheckpointRecorded, opens in the thousands.
  expect(result.last).toBe(result.cut);
  expect(result.opens).toBeLessThan(5);
});

/**
 * Finding 2. `ArchiveSession` is accepted while the session is In Terminal even
 * with a Turn in flight there (the session machine only refuses in its `live` states, Idle / Working /
 * Needs You), and it neither ends that Turn nor withdraws its pending
 * approvals. Recovery skips Archived sessions, so after a Daemon restart the
 * archived session still has a `working` Turn and a pending approval, against
 * the recovery rule (a working Turn becomes Interrupted, pending approvals are
 * withdrawn). Spec: `restartWithdrawsApprovals` / the recovery rule; the spec
 * does not model Archive, so this one came from reading the code next to it.
 *
 * Fixed: `ArchiveSession` is refused while a Turn is in flight in every state,
 * with the live states' reason, so an Archived session never holds a working
 * Turn or a pending approval (spec: `archivedIsClosed`). Recovery also closes
 * what an older log left open in an Archived session.
 */
test("archiving an In Terminal session mid-Turn is refused, and nothing is left open after a restart", async () => {
  const filename = join(tempDir(), "state.sqlite");
  const fakes = makeFakes();
  const s = SessionId.make("s-tui");
  const claude = makeFakeDriver("claude", { onTurn: completesTurns(), follow: true });
  await run(
    engineLayer({ filename, fakes, drivers: [claude] }),
    Effect.gen(function* () {
      yield* startSession(s);
      yield* dispatch(Command.cases.OpenInTerminal.make({ sessionId: s }));
      yield* waitFor((m) => m.sessions.get(s)?.session.state === "in-terminal");
      yield* Effect.sleep(20);
      // The user types a Turn in the terminal UI, which asks for approval.
      const turnId = TurnId.make("t-typed");
      claude.follow.emit(
        s,
        HarnessEvent.TurnStarted({ turnId, prompt: "typed in the TUI" }),
        HarnessEvent.ApprovalRequested({
          turnId,
          requestId: RequestId.make("req-tui"),
          kind: "command",
          title: "Run a command",
          detail: null,
          options: [],
        })
      );
      yield* waitFor((m) => (m.sessions.get(s)?.pending.size ?? 0) === 1);

      const refused = yield* Effect.flip(
        dispatch(Command.cases.ArchiveSession.make({ sessionId: s, deleteMergedBranch: false }))
      );

      expect(refused).toBeInstanceOf(CommandRejected);
      expect(refused).toMatchObject({ reason: "interrupt the Turn in flight before archiving" });
      // The Turn ends in the terminal UI (its request goes with it); then Archive is accepted.
      claude.follow.emit(s, HarnessEvent.TurnEnded({ turnId, status: "completed", error: null }));
      yield* waitFor((m) => (m.sessions.get(s)?.pending.size ?? 1) === 0);
      yield* dispatch(
        Command.cases.ArchiveSession.make({ sessionId: s, deleteMergedBranch: false })
      );
      yield* waitFor((m) => m.sessions.get(s)?.session.state === "archived");
    })
  );
  await run(
    engineLayer({ filename, fakes, drivers: [makeFakeDriver("claude")] }),
    Effect.gen(function* () {
      const record = (yield* Effect.flatMap(EventStore, (store) => store.model)).sessions.get(s)!;
      expect(record.session.state).toBe("archived");
      expect(record.turns.filter((t) => t.status === "working")).toEqual([]);
      expect(record.pending.size).toBe(0);
    })
  );
});

/**
 * Finding 3. The engine records a Harness's `ApprovalRequested` whatever the
 * state of its Turn. A request that arrives after the Turn ended (a stale or
 * misbehaving Harness) puts the session in Needs You with no Turn in flight;
 * answering it moves the session to Working, still with no Turn; and then
 * `SendTurn` is refused ("wait for the Turn to end") until a Daemon restart
 * sends the session Dormant. Found by trace validation: the spec's
 * `harnessReports` only lets a Harness ask during a Turn, and replaying a log
 * where the fake Harness asked right after ending its Turn failed there.
 *
 * Fixed: the session machine ignores an `ApprovalRequested` whose `turnId` is
 * not the session's Turn in flight, as `TurnEnded` ignores a Turn that is not
 * working, and answering (or withdrawing) the last request moves a session to
 * Working only with a Turn in flight (spec: `approvalsNeedATurn`,
 * `workingHasATurn`).
 */
test("a late approval request cannot leave a session Working without a Turn", async () => {
  const codex = makeFakeDriver("codex");
  const s = SessionId.make("s-late");
  await run(
    engineLayer({
      filename: join(tempDir(), "state.sqlite"),
      fakes: makeFakes(),
      drivers: [codex],
    }),
    Effect.gen(function* () {
      const repo = fakeRepo();
      yield* dispatch(Command.cases.RegisterWorkspace.make({ path: repo, name: null }));
      const model = yield* waitFor((m) => m.workspaces.size === 1);
      yield* dispatch(
        Command.cases.StartSession.make({
          sessionId: s,
          workspaceId: [...model.workspaces.values()][0]!.id,
          harness: "codex",
          placement: SessionPlacement.cases.InPlace.make({}),
          permissionMode: "supervised",
          model: null,
          effort: null,
          prompt: "go",
          attachments: [],
        })
      );
      yield* waitFor((m) => m.sessions.get(s)?.session.state === "working");
      const harness = codex.latest(s)!;
      const turnId = harness.turns[0]!.turnId;
      harness.emit(
        HarnessEvent.TurnEnded({ turnId, status: "completed", error: null }),
        HarnessEvent.ApprovalRequested({
          turnId,
          requestId: RequestId.make("req-late"),
          kind: "command",
          title: "Run a command",
          detail: null,
          options: [],
        })
      );
      yield* waitFor((m) => m.sessions.get(s)?.turns[0]?.status === "completed");
      yield* Effect.sleep(50);
      const late = (yield* Effect.flatMap(EventStore, (store) => store.model)).sessions.get(s)!;
      expect(late.pending.size).toBe(0);
      expect(late.session.state).toBe("idle");

      // The late request was never recorded, so there is nothing to answer.
      const answered = yield* Effect.flip(
        dispatch(
          Command.cases.RespondToApproval.make({
            sessionId: s,
            requestId: RequestId.make("req-late"),
            decision: ApprovalDecision.cases.Allow.make({ remember: false }),
          })
        )
      );

      expect(answered).toBeInstanceOf(CommandRejected);
      expect(answered).toMatchObject({ reason: "request req-late is already resolved" });

      // With no Turn in flight, a new one must be accepted.
      const sent = yield* Effect.exit(
        dispatch(Command.cases.SendTurn.make({ sessionId: s, prompt: "next", attachments: [] }))
      );

      expect(sent._tag).toBe("Success");
    })
  );
});

/**
 * Finding 4 (M2, found while specifying `AcceptTurns`). Accepting an
 * Interrupted Turn, then Continue, resumed that same Turn: work the user had
 * accepted changed after they accepted it. Spec: `acceptedNeverInFlight`
 * (mutant `finding4`).
 *
 * Fixed in the same change: Continue is refused once the Interrupted Turn is
 * accepted; a new Turn carries on instead.
 */
test("an accepted Interrupted Turn is not continued", async () => {
  const filename = join(tempDir(), "state.sqlite");
  const fakes = makeFakes();
  const s = SessionId.make("s-accept");
  await run(
    engineLayer({ filename, fakes, drivers: [makeFakeDriver("claude")] }),
    Effect.gen(function* () {
      const repo = fakeRepo();
      yield* dispatch(Command.cases.RegisterWorkspace.make({ path: repo, name: null }));
      const model = yield* waitFor((m) => m.workspaces.size === 1);
      yield* dispatch(
        Command.cases.StartSession.make({
          sessionId: s,
          workspaceId: [...model.workspaces.values()][0]!.id,
          harness: "claude",
          placement: SessionPlacement.cases.InPlace.make({}),
          permissionMode: "supervised",
          model: null,
          effort: null,
          prompt: "Fix the flaky test",
          attachments: [],
        })
      );
      yield* waitFor((m) => m.sessions.get(s)?.turns[0]?.status === "working");
    })
  );
  // The Daemon restarts with the Turn in flight: it ends Interrupted, and the session Needs You.
  await run(
    engineLayer({ filename, fakes, drivers: [makeFakeDriver("claude")] }),
    Effect.gen(function* () {
      const record = (yield* waitFor(
        (m) => m.sessions.get(s)?.session.state === "needs-you"
      )).sessions.get(s)!;

      const turn = record.turns[0]!;
      expect(turn.status).toBe("interrupted");

      yield* dispatch(
        Command.cases.AcceptTurns.make({
          sessionId: s,
          throughTurnId: turn.id,
          revertLaterTurns: false,
        })
      );

      const refused = yield* Effect.flip(dispatch(Command.cases.Continue.make({ sessionId: s })));
      expect(refused).toMatchObject({
        reason: "the Interrupted Turn is accepted; send a new Turn instead",
      });
    })
  );
});
