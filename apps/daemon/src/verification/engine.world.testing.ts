/**
 * The real system the Engine model-based test drives (`engine.model.slow.test.ts`):
 * the Engine on a SQLite file with the fake Harness, two devices' connections,
 * and their Client feeds (the real `makeFeed`, wired as `HostConnection` does).
 */
import { HarnessEvent } from "../harness/HarnessDriver.ts";
import { removeTempDirectory } from "./tempDirectories.testing.ts";
import { join } from "node:path";
import { type Feed, makeFeed, type SequenceMark } from "@polaris/client";
import {
  type Capability,
  type Command,
  CommandId,
  type CommandRejected,
  type EventEnvelope,
  HostStreamItem,
  type NotFound,
  type NotGranted,
  RequestId,
  Sequence,
  SessionId,
  SessionStreamItem,
  TurnItem,
  TurnId,
  TurnTrigger,
} from "@polaris/protocol";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Latch,
  ManagedRuntime,
  Option,
  Predicate,
  Queue,
  Scope,
  Stream,
} from "effect";
import { Engine } from "../engine/Engine.ts";
import {
  engineLayer,
  type FakeDriver,
  type FakeHarnessSession,
  type Fakes,
  tempDir,
} from "../engine/testing.ts";
import { EventStore } from "../store/EventStore.ts";
import type { ReadModel } from "../store/model.ts";
import {
  type AEvent,
  abstractEvent,
  CLIENTS,
  type ClientName,
  SESSIONS,
  type SessionName,
  STREAMS,
  type StreamName,
  streamSeqs,
} from "./engine.reference.testing.ts";

/** What the runs reached, printed with POLARIS_PBT_STATS=1. */

/** The Clients here are current: they decode every event, Review's included. */
const ANNOUNCED: ReadonlyArray<Capability> = ["session.accept", "review.checkouts"];

export const reached = {
  commands: 0,
  rejected: 0,
  retries: 0,
  answerRaces: 0,
  approvalsResolved: 0,
  withdrawnByHarness: 0,
  withdrawnByDaemon: 0,
  continued: 0,
  retried: 0,
  archived: 0,
  unarchived: 0,
  accepted: 0,
  lateRequests: 0,
  crashes: 0,
  crashesMidBurst: 0,
  interruptedByRestart: 0,
  feedSnapshots: 0,
  feedDrops: 0,
  disconnects: 0,
};

export type HarnessWhat =
  | "item"
  | "delta"
  | "request"
  | "withdraw"
  | "end"
  | "fail"
  | "limit"
  | "late"
  | "auto";

// ── Client feeds ────────────────────────────────────────────────────────────

class Disconnected {
  readonly _tag = "Disconnected";
}

/** One Client's connection to the Daemon; `closed` completes when it drops. */
interface Conn {
  readonly epoch: number;
  readonly engine: Engine["Service"];
  readonly closed: Deferred.Deferred<void>;
}

type Seen =
  | { readonly kind: "snapshot"; readonly seq: number }
  | { readonly kind: "event"; readonly seq: number };

export interface FeedState {
  readonly client: ClientName;
  readonly stream: StreamName;
  readonly gate: Latch.Latch;
  /** What the feed's subscriber received, in order. */
  readonly seen: Array<Seen>;
  readonly errors: Array<string>;
  /** Snapshot contents: session → [state, pending request ids]. */
  readonly snapshots: Array<{
    readonly seq: number;
    readonly sessions: Map<string, readonly [string, ReadonlyArray<string>]>;
  }>;
  feed: Feed<unknown, unknown> | null;
  consumer: Fiber.Fiber<unknown, unknown> | null;
}

const markHost = (item: HostStreamItem): SequenceMark =>
  HostStreamItem.match<SequenceMark>(item, {
    Event: (event) => ({ kind: "event", sequence: event.envelope.sequence }),
    Snapshot: (snapshot) => ({ kind: "snapshot", sequence: snapshot.sequence }),
    Synchronized: (synced) => ({ kind: "synchronized", sequence: synced.sequence }),
  });

const markSession = (item: SessionStreamItem): SequenceMark =>
  SessionStreamItem.match<SequenceMark>(item, {
    Snapshot: (snapshot) => ({ kind: "snapshot", sequence: snapshot.sequence }),
    Event: (event) => ({ kind: "event", sequence: event.envelope.sequence }),
    Synchronized: (synced) => ({ kind: "synchronized", sequence: synced.sequence }),
    Delta: () => ({ kind: "ephemeral" }),
    ItemProgress: () => ({ kind: "ephemeral" }),
  });

type Snapshot = Extract<HostStreamItem | SessionStreamItem, { readonly _tag: "Snapshot" }>;

const pendingOf = (requests: ReadonlyArray<{ readonly id: RequestId }>) =>
  requests.map((r): string => r.id).sort();

const onSnapshot = (fs: FeedState, item: Snapshot) => {
  reached.feedSnapshots++;
  fs.seen.push({ kind: "snapshot", seq: item.sequence });
  const sessions = new Map<string, readonly [string, ReadonlyArray<string>]>();

  if ("sessions" in item) {
    for (const summary of item.sessions) {
      sessions.set(summary.session.id, [
        summary.session.state,
        pendingOf(summary.pendingApprovals),
      ]);
    }
  } else {
    sessions.set(item.session.id, [item.session.state, pendingOf(item.pendingApprovals)]);
  }

  fs.snapshots.push({ seq: item.sequence, sessions });
};

const onEvent = (fs: FeedState, seq: number) => {
  const last = fs.seen.at(-1);

  if (last !== undefined && seq <= last.seq) fs.errors.push(`got ${seq} after ${last.seq}`);
  fs.seen.push({ kind: "event", seq });
};

const onItem = (fs: FeedState, item: HostStreamItem | SessionStreamItem) => {
  if (Predicate.isTagged(item, "Snapshot")) onSnapshot(fs, item);
  else if (Predicate.isTagged(item, "Event")) onEvent(fs, item.envelope.sequence);
};

/** The view a feed's subscriber holds: a Snapshot resets it to the stream up to its sequence. */
export const viewOfFeed = (fs: FeedState, log: ReadonlyArray<AEvent>) => {
  let view: Array<number> = [];

  for (const s of fs.seen) {
    if (s.kind === "snapshot") view = streamSeqs(log, fs.stream).filter((x) => x <= s.seq);
    else view.push(s.seq);
  }

  return view;
};

const toSequence = (after: number | null) => (after === null ? null : Sequence.make(after));

const sessionIdOf = (session: SessionName | null) =>
  session === null ? null : SessionId.make(session);

// ── The world ───────────────────────────────────────────────────────────────

export interface Sent {
  readonly id: string;
  readonly device: ClientName;
  readonly command: Command;
  /** The sequence when it was sent, and when it was answered (null: no answer yet). */
  readonly from: number;
  to: number | null;
  /** "seq:<n>", "seq:null" or "rejected:<reason>"; null while unanswered or lost in a crash. */
  answer: string | null;
}

/** What a device heard back for a command, as `Sent.answer` records it (null: nothing). */
const answerOf = (
  exit: Exit.Exit<{ readonly sequence: Sequence | null }, CommandRejected | NotFound | NotGranted>
) => {
  if (Exit.isSuccess(exit)) return `seq:${exit.value.sequence}`;
  const error = Cause.findErrorOption(exit.cause);

  if (Option.isSome(error) && Predicate.isTagged(error.value, "CommandRejected")) {
    reached.rejected++;

    return `rejected:${error.value.reason}`;
  }

  return Cause.hasInterruptsOnly(exit.cause) ? null : `failed:${Cause.pretty(exit.cause)}`;
};

/** The fakes a World runs the Engine with; each Daemon start gets a fresh fake Harness driver. */
export interface WorldFakes {
  readonly fakes: Fakes;
  readonly newDriver: () => FakeDriver;
}

export class World {
  runtime: ManagedRuntime.ManagedRuntime<Engine | EventStore, never> | null = null;
  driver: FakeDriver;
  readonly directory = tempDir();
  readonly filename = join(this.directory, "state.sqlite");
  readonly fakes: Fakes;
  readonly conns = new Map<ClientName, Conn>();
  /** Every command a Client sent, in order; a retry is another entry with the same id. */
  readonly sent: Array<Sent> = [];
  /** The sequence right after each restart's recovery (for traces). */
  readonly restarts: Array<number> = [];
  readonly feeds: Array<FeedState> = [];
  /** Client feeds live outside the Daemon: they outlast its crashes. */
  readonly clientScope = Effect.runSync(Scope.make());
  /** Command ids whose block was already checked against the reference decider. */
  readonly checkedBlocks = new Set<string>();
  requestCounter = 0;
  /** Turns a fake Harness already reported ended. */
  readonly endedTurns = new Set<string>();
  itemCounter = 0;

  constructor(
    readonly capacity: number,
    private readonly deps: WorldFakes
  ) {
    this.fakes = deps.fakes;
    this.driver = deps.newDriver();
  }

  get rt() {
    if (this.runtime === null) throw new Error("the Daemon is down");

    return this.runtime;
  }

  store() {
    return this.rt.runSync(Effect.map(EventStore, (s) => s));
  }

  model(): ReadModel {
    return this.rt.runSync(Effect.flatMap(EventStore, (s) => s.model));
  }

  async open() {
    this.driver = this.deps.newDriver();
    this.runtime = ManagedRuntime.make(
      engineLayer({
        filename: this.filename,
        fakes: this.fakes,
        drivers: [this.driver],
        subscriberCapacity: this.capacity,
      })
    );
    // Building the layer runs recovery before anything else can happen.
    const engine = await this.rt.runPromise(Effect.map(Engine, (e) => e));

    for (const client of CLIENTS) {
      const epoch = (this.conns.get(client)?.epoch ?? 0) + 1;
      this.conns.set(client, { epoch, engine, closed: Deferred.makeUnsafe<void>() });
    }
  }

  /** A Client's connection drops and comes back (the Daemon keeps running). */
  disconnect(client: ClientName) {
    const conn = this.conns.get(client);

    if (conn === undefined || Deferred.isDoneUnsafe(conn.closed)) return;
    reached.disconnects++;
    Deferred.doneUnsafe(conn.closed, Exit.void);
    this.conns.set(client, { ...conn, epoch: conn.epoch + 1, closed: Deferred.makeUnsafe<void>() });
  }

  /** The Daemon goes away; every connection with it. */
  async crash() {
    const runtime = this.rt;

    for (const conn of this.conns.values()) Deferred.doneUnsafe(conn.closed, Exit.void);
    this.runtime = null;
    await runtime.dispose();
  }

  /** Every committed event, through the store's public read side, as of one cut. */
  async readLog(): Promise<Array<AEvent>> {
    const store = this.store();

    return this.rt.runPromise(
      Effect.gen(function* () {
        const cut = (yield* store.model).sequence;

        const parts = yield* Effect.forEach([null, ...SESSIONS], (session) =>
          store.readEvents({ after: 0, upTo: cut, sessionId: sessionIdOf(session) })
        );

        const bySeq = new Map<number, EventEnvelope>();

        for (const part of parts) for (const e of part) bySeq.set(e.sequence, e);

        return [...bySeq.values()].sort((a, b) => a.sequence - b.sequence).map(abstractEvent);
      })
    );
  }

  private nextConn(client: ClientName, min: number) {
    const conns = this.conns;

    return Effect.gen(function* () {
      while (true) {
        const conn = conns.get(client);

        if (conn !== undefined && conn.epoch >= min && !Deferred.isDoneUnsafe(conn.closed)) {
          return { epoch: conn.epoch, client: conn };
        }

        yield* Effect.sleep(2);
      }
    });
  }

  /** One device's feed of one stream, over a detached "network" (see `wire`). */
  private openFeed(fs: FeedState): Promise<Feed<HostStreamItem | SessionStreamItem, unknown>> {
    const source = { next: (min: number) => this.nextConn(fs.client, min) };
    const stream = fs.stream;

    // Detached, as across a network: a dropped connection never waits for the Daemon side.
    // A stalled Client stops reading, so the Daemon stops pulling and its hub buffer fills.
    const wire = <A, E>(conn: Conn, upstream: Stream.Stream<A, E>) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const queue = yield* Queue.bounded<A, E | Cause.Done>(1);

          const server = Effect.runFork(
            Stream.runIntoQueue(upstream, queue).pipe(
              // The Daemon ended the stream on its own: it dropped a stalled subscriber.
              Effect.tap(() => Effect.sync(() => void reached.feedDrops++))
            )
          );

          yield* Effect.addFinalizer(() =>
            Effect.sync(() => void Effect.runFork(Fiber.interrupt(server)))
          );

          return Stream.fromQueue(queue).pipe(
            Stream.tap(() => fs.gate.await),
            Stream.interruptWhen(
              Deferred.await(conn.closed).pipe(Effect.andThen(Effect.fail(new Disconnected())))
            )
          );
        })
      );

    if (stream === "host") {
      return Effect.runPromise(
        makeFeed<Conn, HostStreamItem, Disconnected>({
          source,
          open: (conn, after) =>
            wire(conn, conn.engine.subscribeHost(toSequence(after), { capabilities: ANNOUNCED })),
          mark: markHost,
          isDisconnect: (e) => e instanceof Disconnected,
          // As HostConnection opens it: the host stream leaves out session-only
          // events, so it has gaps (ENG-209 finding 1).
          gapless: false,
          reopenDelayMs: 1,
        }).pipe(Scope.provide(this.clientScope))
      );
    }

    return Effect.runPromise(
      makeFeed<Conn, SessionStreamItem, NotFound | Disconnected>({
        source,
        open: (conn, after) =>
          wire(
            conn,
            conn.engine.subscribeSession({
              sessionId: SessionId.make(stream),
              afterSequence: toSequence(after),
              turnLimit: null,
              capabilities: ANNOUNCED,
            })
          ),
        mark: markSession,
        isDisconnect: (e) => e instanceof Disconnected,
        gapless: false,
        reopenDelayMs: 1,
      }).pipe(Scope.provide(this.clientScope))
    );
  }

  /** Both devices' feeds (host, s1, s2), wired as HostConnection wires them. */
  async startFeeds() {
    for (const client of CLIENTS) {
      for (const stream of STREAMS) {
        const fs: FeedState = {
          client,
          stream,
          gate: Latch.makeUnsafe(true),
          seen: [],
          errors: [],
          snapshots: [],
          feed: null,
          consumer: null,
        };

        const feed = await this.openFeed(fs);
        fs.feed = feed;
        fs.consumer = Effect.runFork(
          feed.stream.pipe(
            Stream.runForEach((item) => Effect.sync(() => onItem(fs, item))),
            Effect.catchCause((cause) =>
              Effect.sync(() => void fs.errors.push(Cause.pretty(cause)))
            )
          )
        );
        this.feeds.push(fs);
      }
    }
  }

  async dispose() {
    try {
      for (const fs of this.feeds) {
        if (fs.consumer !== null) await Effect.runPromise(Fiber.interrupt(fs.consumer));
      }

      await Effect.runPromise(Scope.close(this.clientScope, Exit.void));

      if (this.runtime !== null) await this.crash();
    } finally {
      removeTempDirectory(this.directory);
    }
  }

  /** Send a command from a device and record what it heard back. */
  dispatch(device: ClientName, id: string, command: Command): Promise<void> {
    const conn = this.conns.get(device);

    if (this.runtime === null || conn === undefined || Deferred.isDoneUnsafe(conn.closed)) {
      return Promise.resolve();
    }

    const sent: Sent = { id, device, command, from: this.model().sequence, to: null, answer: null };
    this.sent.push(sent);
    reached.commands++;
    const runtime = this.runtime;

    return Effect.runPromiseExit(
      conn.engine.dispatch({ commandId: CommandId.make(id), command, deviceLabel: device })
    ).then((exit) => {
      // Answers from a Daemon that died meanwhile never reach the Client.
      if (this.runtime !== runtime) return;
      sent.to = this.model().sequence;
      sent.answer = answerOf(exit);
    });
  }

  /** Something a live Harness of `session` reports (no-op if none runs). */
  harness(session: SessionName, what: HarnessWhat, pick: number) {
    const harness = this.driver.latest(SessionId.make(session));

    if (harness === undefined || harness.closed || this.runtime === null) return;

    if (what === "late") return this.lateRequest(harness, pick);

    if (what === "auto") {
      const record = this.model().sessions.get(SessionId.make(session));

      if (record?.session.state !== "idle") return;
      const turnId = TurnId.make(`auto-${++this.itemCounter}`);
      harness.emit(
        HarnessEvent.TurnStarted({
          turnId,
          prompt: null,
          trigger: TurnTrigger.cases.BackgroundTasksReported.make({
            tasks: [{ id: "sub1", kind: "subagent" }],
          }),
        })
      );
      harness.emit(HarnessEvent.TurnEnded({ turnId, status: "completed", error: null }));

      return;
    }

    // Reports only for the Turn it runs, until it reports its end (the spec's `harnessReports`),
    // from the fake's own view: the read model may lag behind what it emitted.
    const sent = harness.turns.at(-1)?.turnId;
    const turnId = sent !== undefined && !this.endedTurns.has(sent) ? sent : undefined;

    if (what === "withdraw") return this.withdraw(session, harness, pick);

    if (turnId === undefined) return;

    switch (what) {
      case "item":
        return harness.emit(
          HarnessEvent.ItemCompleted({
            turnId,
            item: TurnItem.cases.AssistantMessage.make({
              id: `msg-${++this.itemCounter}`,
              text: "ok",
            }),
          })
        );
      case "delta":
        return harness.emit(
          HarnessEvent.ItemDelta({ turnId, itemId: "m", field: "text", text: "…" })
        );
      case "request":
        return harness.emit(
          HarnessEvent.ApprovalRequested({
            turnId,
            requestId: RequestId.make(`req-${++this.requestCounter}`),
            kind: "command",
            title: "Run a command",
            detail: null,
            options: [],
          })
        );
      case "end":
        this.endedTurns.add(turnId);

        return harness.emit(HarnessEvent.TurnEnded({ turnId, status: "completed", error: null }));
      case "fail":
        this.endedTurns.add(turnId);

        return harness.emit(HarnessEvent.TurnEnded({ turnId, status: "failed", error: "boom" }));
      case "limit":
        this.endedTurns.add(turnId);

        return harness.emit(
          HarnessEvent.TurnEnded({
            turnId,
            status: "failed",
            error: "You've hit your limit",
            limit: { resetsAt: null },
          })
        );
    }
  }

  /** A stale Harness asks about a Turn it already ended (ENG-209 finding 3). */
  private lateRequest(harness: FakeHarnessSession, pick: number) {
    // Ignored, unless a Continue after a crash resumed that Turn since.
    const ended = harness.turns.map((t) => t.turnId).filter((t) => this.endedTurns.has(t));

    if (ended.length === 0) return;
    reached.lateRequests++;
    harness.emit(
      HarnessEvent.ApprovalRequested({
        turnId: ended[pick % ended.length]!,
        requestId: RequestId.make(`late-${++this.requestCounter}`),
        kind: "command",
        title: "Run a command",
        detail: null,
        options: [],
      })
    );
  }

  private withdraw(session: SessionName, harness: FakeHarnessSession, pick: number) {
    const record = this.model().sessions.get(SessionId.make(session));
    const pending = [...(record?.pending.keys() ?? [])];

    if (pending.length === 0) return;
    harness.emit(HarnessEvent.ApprovalWithdrawn({ requestId: pending[pick % pending.length]! }));
  }
}
