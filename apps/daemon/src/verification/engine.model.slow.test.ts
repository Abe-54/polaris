/**
 * Model-based test of the Engine (ENG-209), through public APIs only:
 * `Engine.dispatch`, `subscribeHost` / `subscribeSession`, the EventStore's
 * read side, the scriptable fake Harness (`engine/testing.ts`), and the
 * Client's resumable feeds (`makeFeed` from @polaris/client, set up as
 * `HostConnection` does).
 *
 * fast-check generates runs of: concurrent bursts of commands from two devices
 * (fresh and retried command ids, stale and racing approval answers, Archive
 * and Unarchive) mixed with Harness events (items, approval requests and
 * withdrawals, Turn ends, and late approval requests for a Turn that ended),
 * in an order and batching `fc.scheduler` picks; pauses of Client feeds (a
 * stalled Client, which the Daemon drops at `subscriberCapacity`); connection
 * drops; and Daemon crashes (the layer torn down, possibly mid-burst, the same
 * SQLite file reopened, and recovery run). After every step:
 *
 *   - the log is gapless, and each command id's events are one decision that a
 *     reference decider agrees with, given the log right before it; each
 *     rejection was right at some point while the command was in flight;
 *   - every answer is backed by committed events, and a retry gets the
 *     original answer;
 *   - each approval request closes at most once, after it was opened; the
 *     first answer wins and the recorded device is the one that was accepted;
 *   - no Turn starts or continues without a Client's command;
 *   - an approval is pending, and a session Working, only with a Turn in
 *     flight; an Archived session holds neither;
 *   - the read model equals a reference fold of the log (also after reloads);
 *   - every Client feed has seen exactly a prefix of its committed stream, and
 *     each Snapshot matches the log at its sequence.
 *
 * Right after a restart, before any command: no Turn is working, no approval
 * is pending, a Turn that was working is Interrupted and its session Needs
 * You, and no Harness was opened (no auto-continue). At the end of a run,
 * every feed catches up with its stream.
 *
 * The reference side is in `engine.reference.testing.ts`, the real system in
 * `engine.world.testing.ts` and the checks in `engine.invariants.testing.ts`.
 * The same properties are specified in `packages/spec/polaris.qnt`.
 */
import { HarnessEvent } from "../harness/HarnessDriver.ts";
import { describe, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ApprovalDecision,
  Command,
  CommandId,
  RequestId,
  SessionId,
  SessionPlacement,
} from "@polaris/protocol";
import { Effect, Latch, Predicate } from "effect";
import fc from "fast-check";
import { Engine } from "../engine/Engine.ts";
import { type FakeDriver, fakeRepo, makeFakeDriver, makeFakes } from "../engine/testing.ts";
import { checkInvariants } from "./engine.invariants.testing.ts";
import {
  type AEvent,
  CLIENTS,
  type ClientName,
  SESSIONS,
  type SessionName,
  streamSeqs,
} from "./engine.reference.testing.ts";
import { type HarnessWhat, reached, viewOfFeed, World } from "./engine.world.testing.ts";
import { eventually, isPrefix, pbtRuns, pbtSeed, pbtTimeout, sleep } from "./pbt.ts";
import { posixTest } from "../platform/testing.ts";

const TRACE_DIR = process.env.POLARIS_TRACE_DIR;

// ── fast-check commands ─────────────────────────────────────────────────────

type DispatchKind =
  | "SendTurn"
  | "Continue"
  | "Retry"
  | "Respond"
  | "Interrupt"
  | "Rename"
  | "SetModel"
  | "Archive"
  | "Unarchive"
  | "Accept";

type Action =
  | {
      readonly tag: "dispatch";
      readonly device: ClientName;
      readonly kind: DispatchKind;
      readonly s: SessionName;
      readonly pick: number;
      /** Reuse an earlier command (same id, same command, same device): a retry. */
      readonly retry: number | null;
    }
  | {
      readonly tag: "harness";
      readonly s: SessionName;
      readonly what: HarnessWhat;
      readonly pick: number;
    }
  /** Both devices answer the same pending request at once. */
  | { readonly tag: "race"; readonly s: SessionName; readonly pick: number };

type DispatchAction = Extract<Action, { tag: "dispatch" }>;

/** The Engine test keeps no model of its own: the committed log is the reference. */
type NoModel = Record<never, never>;

type Cmd = fc.AsyncCommand<NoModel, World>;

abstract class Step implements Cmd {
  check = () => true;
  abstract step(world: World): Promise<void>;
  async run(_model: NoModel, world: World) {
    await this.step(world);
    await checkInvariants(world);
  }
}

let idCounter = 0;

/** A pending request, or sometimes one already closed (a late answer); null if none exists. */
const respondCommand = (world: World, action: DispatchAction, sessionId: SessionId) => {
  const model = world.model();
  const pending = [...(model.sessions.get(sessionId)?.pending.keys() ?? [])];

  const any = Array.from({ length: world.requestCounter }, (_, i) =>
    RequestId.make(`req-${i + 1}`)
  );

  const pool = pending.length > 0 && action.pick % 4 !== 0 ? pending : any;

  if (pool.length === 0) return null;
  const requestId = pool[action.pick % pool.length]!;

  return Command.cases.RespondToApproval.make({
    sessionId: model.sessions.get(sessionId)?.pending.get(requestId)?.sessionId ?? sessionId,
    requestId,
    decision: ApprovalDecision.cases.Allow.make({ remember: false }),
  });
};

/** Accept through one of the session's Turns (any: in flight, older than accepted, the latest). */
const acceptCommand = (world: World, action: DispatchAction, sessionId: SessionId) => {
  const turns = world.model().sessions.get(sessionId)?.turns ?? [];

  if (turns.length === 0) return null;

  return Command.cases.AcceptTurns.make({
    sessionId,
    throughTurnId: turns[action.pick % turns.length]!.id,
    revertLaterTurns: false,
  });
};

const commandFor = (world: World, action: DispatchAction): Command | null => {
  const sessionId = SessionId.make(action.s);

  switch (action.kind) {
    case "SendTurn":
      return Command.cases.SendTurn.make({ sessionId, prompt: "go on", attachments: [] });
    case "Continue":
      return Command.cases.Continue.make({ sessionId });
    case "Retry":
      return Command.cases.Retry.make({ sessionId });
    case "Interrupt":
      return Command.cases.Interrupt.make({ sessionId });
    case "Rename":
      return Command.cases.RenameSession.make({ sessionId, title: `t${idCounter}` });
    case "SetModel":
      return Command.cases.SetModel.make({ sessionId, model: `m${idCounter}`, effort: null });
    case "Archive":
      return Command.cases.ArchiveSession.make({ sessionId, deleteMergedBranch: false });
    case "Unarchive":
      return Command.cases.UnarchiveSession.make({ sessionId });
    case "Accept":
      return acceptCommand(world, action, sessionId);
    case "Respond":
      return respondCommand(world, action, sessionId);
  }
};

const toDispatch = (world: World, action: DispatchAction) => {
  if (action.retry !== null && world.sent.length > 0) {
    const earlier = world.sent[action.retry % world.sent.length]!;

    return { device: earlier.device, id: earlier.id, command: earlier.command };
  }

  const command = commandFor(world, action);

  if (command === null) return null;

  return { device: action.device, id: `cmd-${++idCounter}`, command };
};

const describeAction = (a: Action) => {
  switch (a.tag) {
    case "harness":
      return `${a.s}.${a.what}`;
    case "race":
      return `race(${a.s})`;
    case "dispatch":
      return `${a.device}:${a.retry === null ? a.kind : `retry#${a.retry}`}(${a.s})`;
  }
};

class Burst extends Step {
  constructor(
    readonly actions: ReadonlyArray<Action>,
    readonly scheduler: fc.Scheduler,
    readonly crashAfter: number | null
  ) {
    super();
  }

  override async step(world: World) {
    const runtime = world.rt;
    const done: Array<Promise<void>> = [];

    const actions = this.actions.flatMap((action): ReadonlyArray<Action> =>
      action.tag === "race"
        ? CLIENTS.map((device) => ({
            tag: "dispatch",
            device,
            kind: "Respond",
            s: action.s,
            pick: action.pick * 4 + 1,
            retry: null,
          }))
        : [action]
    );

    for (const action of actions) {
      done.push(
        this.scheduler.schedule(Promise.resolve(), action.tag).then(() => {
          if (world.runtime !== runtime) return;

          if (action.tag === "harness") return world.harness(action.s, action.what, action.pick);

          if (action.tag === "race") return;
          const d = toDispatch(world, action);

          if (d === null) return;

          return world.dispatch(d.device, d.id, d.command);
        })
      );
    }

    if (this.crashAfter === null) {
      await this.scheduler.waitIdle();
      await Promise.all(done);
      await sleep(2);

      return;
    }

    const upTo = Math.min(this.crashAfter ?? 0, this.scheduler.count());

    if (upTo > 0) await this.scheduler.waitNext(upTo);
    reached.crashesMidBurst++;
    await restart(world);
    await this.scheduler.waitIdle();
  }

  override toString() {
    const acts = this.actions.map(describeAction).join(", ");

    return `Burst(${acts}${this.crashAfter === null ? "" : `; crash after ${this.crashAfter}`})`;
  }
}

/** Crash, reopen, and check the recovery rule before anything else happens. */
const restart = async (world: World) => {
  reached.crashes++;
  const before = world.model();
  await world.crash();
  await world.open();
  const after = world.model();
  world.restarts.push(after.sequence);
  expect(world.driver.sessions).toHaveLength(0); // nothing continued on its own

  for (const [id, record] of after.sessions) {
    expect(record.turns.filter((t) => t.status === "working")).toEqual([]);
    expect(record.pending.size).toBe(0);
    const was = before.sessions.get(id);
    const wasWorking = was?.turns.find((t) => t.status === "working");

    if (wasWorking !== undefined) {
      reached.interruptedByRestart++;
      expect(record.turns.find((t) => t.id === wasWorking.id)?.status).toBe("interrupted");
      expect(record.session.state).toBe("needs-you");
    }
  }
};

class Crash extends Step {
  override async step(world: World) {
    await restart(world);
  }
  override toString() {
    return "Crash";
  }
}

class Disconnect extends Step {
  constructor(readonly device: ClientName) {
    super();
  }
  override async step(world: World) {
    world.disconnect(this.device);
    await sleep(2);
  }
  override toString() {
    return `Disconnect(${this.device})`;
  }
}

class Stall extends Step {
  constructor(
    readonly index: number,
    readonly stalled: boolean
  ) {
    super();
  }
  override async step(world: World) {
    const fs = world.feeds[this.index % world.feeds.length]!;

    if (this.stalled) Latch.closeUnsafe(fs.gate);
    else Latch.openUnsafe(fs.gate);
  }
  override toString() {
    return `${this.stalled ? "Stall" : "Unstall"}(feed ${this.index})`;
  }
}

// ── Arbitraries ─────────────────────────────────────────────────────────────

const sessionArb = fc.constantFrom<SessionName>(...SESSIONS);

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      tag: fc.constant("dispatch" as const),
      device: fc.constantFrom<ClientName>(...CLIENTS),
      kind:
        TRACE_DIR === undefined
          ? fc.constantFrom(
              "SendTurn",
              "Continue",
              "Retry",
              "Respond",
              "Respond",
              "Interrupt",
              "Rename",
              "SetModel",
              "Archive",
              "Unarchive",
              "Accept"
            )
          : fc.constantFrom(
              "SendTurn",
              "Continue",
              "Retry",
              "Respond",
              "Respond",
              "Rename",
              "SetModel",
              "Archive",
              "Unarchive",
              "Accept"
            ),
      s: sessionArb,
      pick: fc.nat(40),
      retry: fc.option(fc.nat(40), { freq: 4 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      tag: fc.constant("harness" as const),
      s: sessionArb,
      what: fc.constantFrom<HarnessWhat>(
        "item",
        "delta",
        "request",
        "request",
        "withdraw",
        "end",
        "fail",
        "limit",
        "late",
        "auto"
      ),
      pick: fc.nat(40),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ tag: fc.constant("race" as const), s: sessionArb, pick: fc.nat(40) }),
  }
);

const burstArb = fc
  .tuple(fc.array(actionArb, { minLength: 1, maxLength: 6 }), fc.scheduler())
  .map(([actions, s]) => new Burst(actions, s, null));

// fc.commands picks among these uniformly: bursts are listed several times to weigh them.
const commandArbs: Array<fc.Arbitrary<Cmd>> = [
  burstArb,
  burstArb,
  burstArb,
  burstArb,
  fc
    .tuple(fc.array(actionArb, { minLength: 1, maxLength: 5 }), fc.scheduler(), fc.nat(4))
    .map(([actions, s, n]) => new Burst(actions, s, n)),
  fc.constant(new Crash()),
  fc.constantFrom<ClientName>(...CLIENTS).map((d) => new Disconnect(d)),
  fc.tuple(fc.nat(5), fc.boolean()).map(([i, stalled]) => new Stall(i, stalled)),
];

// ── Stats and traces ────────────────────────────────────────────────────────

const tallyLog = (log: ReadonlyArray<AEvent>) => {
  for (const e of log) {
    if (e.tag === "ApprovalResolved") reached.approvalsResolved++;

    if (e.what.endsWith(":harness")) reached.withdrawnByHarness++;

    if (e.what.endsWith(":daemon")) reached.withdrawnByDaemon++;

    if (e.what === "state:archived") reached.archived++;

    if (e.what === "state:dormant" && e.commandId !== null) reached.unarchived++;

    if (e.tag === "TurnsAccepted") reached.accepted++;
  }
};

const tallyAnswerRaces = (world: World) => {
  const answers = new Map<string, Set<string>>();

  for (const sent of world.sent) {
    if (!Predicate.isTagged(sent.command, "RespondToApproval") || sent.answer === null) continue;
    const kinds = answers.get(sent.command.requestId) ?? new Set();
    kinds.add(sent.answer.startsWith("seq:") ? `ok:${sent.id}` : "rejected");
    answers.set(sent.command.requestId, kinds);
  }

  for (const kinds of answers.values())
    if (kinds.has("rejected") && kinds.size > 1) reached.answerRaces++;
};

/** Count what a finished run reached, for POLARIS_PBT_STATS. */
const tally = (world: World, log: ReadonlyArray<AEvent>) => {
  tallyLog(log);
  const ids = new Map<string, number>();

  for (const sent of world.sent) ids.set(sent.id, (ids.get(sent.id) ?? 0) + 1);
  reached.retries += [...ids.values()].filter((n) => n > 1).length;
  tallyAnswerRaces(world);
};

let traceCounter = 0;

/**
 * With POLARIS_TRACE_DIR set, each run writes its committed log, the commands
 * sent and the restart points as JSON, for `packages/spec/scripts/replay.ts`
 * to replay against the spec (trace validation).
 */
const writeTrace = (world: World, log: ReadonlyArray<AEvent>) => {
  if (TRACE_DIR === undefined) return;
  mkdirSync(TRACE_DIR, { recursive: true });
  const sent = new Map<string, { device: string; command: Command }>();

  for (const s of world.sent)
    if (!sent.has(s.id)) sent.set(s.id, { device: s.device, command: s.command });
  writeFileSync(
    join(TRACE_DIR, `engine-${process.pid}-${++traceCounter}.json`),
    JSON.stringify({ log, commands: Object.fromEntries(sent), restarts: world.restarts }, null, 1)
  );
};

// ── The property ────────────────────────────────────────────────────────────

/** A Codex-like fake Harness that ends the Turn in flight Interrupted when interrupted. */
const codexDriver = (): FakeDriver =>
  makeFakeDriver("codex", {
    onInterrupt: (session) => {
      const turn = session.turns.at(-1);

      return turn === undefined
        ? []
        : [HarnessEvent.TurnEnded({ turnId: turn.turnId, status: "interrupted", error: null })];
    },
  });

const RUNS = pbtRuns(12);

const setUp = async (world: World) => {
  await world.open();
  const engine = world.rt.runSync(Effect.map(Engine, (e) => e));
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  const repo = fakeRepo(world.directory);
  await run(
    engine.dispatch({
      commandId: CommandId.make(`setup-ws-${++idCounter}`),
      command: Command.cases.RegisterWorkspace.make({ path: repo, name: null }),
      deviceLabel: "setup",
    })
  );
  const workspace = [...world.model().workspaces.values()][0]!;

  for (const s of SESSIONS) {
    await run(
      engine.dispatch({
        commandId: CommandId.make(`setup-${s}-${++idCounter}`),
        command: Command.cases.StartSession.make({
          sessionId: SessionId.make(s),
          workspaceId: workspace.id,
          harness: "codex",
          placement: SessionPlacement.cases.InPlace.make({}),
          permissionMode: "supervised",
          model: null,
          effort: null,
          prompt: "start",
          attachments: [],
        }),
        deviceLabel: "setup",
      })
    );
  }

  await eventually("the sessions' Harnesses open", () =>
    SESSIONS.every((s) => world.driver.latest(SessionId.make(s)) !== undefined)
  );
  await world.startFeeds();
};

/** Feeds still behind their stream, described for the failure message. */
const feedsBehind = async (world: World) => {
  const log = await world.readLog();

  return world.feeds
    .filter((fs) => !isPrefix(streamSeqs(log, fs.stream), viewOfFeed(fs, log)))
    .map(
      (fs) =>
        `${fs.client}/${fs.stream} at ${viewOfFeed(fs, log).at(-1)} of ` +
        `${streamSeqs(log, fs.stream).at(-1)} (${fs.errors.join("; ")}) ${JSON.stringify(fs.seen)}`
    );
};

describe("Engine, model-based", () => {
  posixTest(
    "Windows bug: the EventStore's SQLite files stay open after a crash and restart, so the world can't remove them (EBUSY)"
  )(
    "commands, approvals, restarts and Client feeds match the reference model",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 6 }),
          fc.commands(commandArbs, { maxCommands: 30, size: "+1" }),
          async (capacity, commands) => {
            const world = new World(capacity, { fakes: makeFakes(), newDriver: codexDriver });

            try {
              await setUp(world);
              await fc.asyncModelRun(() => ({ model: {}, real: world }), commands);

              // Liveness: with every Client reading again and the Daemon up, each feed
              // catches up with its whole stream.
              for (const fs of world.feeds) Latch.openUnsafe(fs.gate);

              const deadline = Date.now() + 5000;

              while ((await feedsBehind(world)).length > 0) {
                if (Date.now() > deadline) {
                  throw new Error(
                    `feeds did not catch up: ${(await feedsBehind(world)).join(", ")}`
                  );
                }

                await sleep(5);
              }

              await checkInvariants(world);
              const log = await world.readLog();
              tally(world, log);
              writeTrace(world, log);
            } finally {
              await world.dispose();
            }
          }
        ),
        { numRuns: RUNS, ...pbtSeed() }
      );

      if (process.env.POLARIS_PBT_STATS === "1") console.info("Engine PBT reached", reached);
    },
    pbtTimeout(RUNS, 3000)
  );
});
