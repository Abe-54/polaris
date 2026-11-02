/**
 * Model-based test of the EventStore (ENG-209), through its public API only.
 *
 * fast-check generates runs of: bursts of concurrent commits (fresh command
 * ids, retries of earlier ids, duplicates within a burst, Daemon events with
 * no id; accepted, rejected, empty and defective decisions) whose start order
 * and batch boundaries `fc.scheduler` picks; pauses and resumes of live
 * subscribers with a small buffer; ephemeral output; and crashes (the layer
 * torn down, mid-burst or between bursts, and the same SQLite file reopened).
 * After every step the real store is compared with a reference model, and
 * each subscriber (subscribe, then cut, then replay, as the Engine's streams
 * do; resubscribe from the last sequence when dropped) must have seen exactly
 * a prefix of its committed stream. The same properties are specified in
 * `packages/spec/polaris.qnt`.
 */
import { describe, expect, test } from "bun:test";
import { tempDirectory, removeTempDirectory } from "./tempDirectories.testing.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CommandId,
  CommandRejected,
  DomainEvent,
  type EventEnvelope,
  SessionId,
  TurnId,
  Workspace,
  WorkspaceId,
} from "@polaris/protocol";
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Latch,
  Layer,
  ManagedRuntime,
  Option,
  Predicate,
  Stream,
} from "effect";
import fc from "fast-check";
import { type CommitResult, EventStore, LiveItem, StoreConfig } from "../store/EventStore.ts";
import { eventually, isPrefix, pbtRuns, pbtSeed, pbtTimeout } from "./pbt.ts";

// ── Commands and decisions ──────────────────────────────────────────────────

type Target = "s1" | "s2" | null;

type Kind =
  | { readonly tag: "append"; readonly targets: ReadonlyArray<Target> }
  | { readonly tag: "reject" }
  | { readonly tag: "empty" }
  | { readonly tag: "defect" };

type IdChoice =
  | { readonly tag: "fresh" }
  /** Retry a command id used earlier in the run (the Client lost the answer, or double-sent). */
  | { readonly tag: "retry"; readonly pick: number }
  /** The id of the commit just before it in the same burst. */
  | { readonly tag: "again" }
  /** An event the Daemon records on its own (`commandId` null). */
  | { readonly tag: "daemon" };

interface CommitSpec {
  readonly id: IdChoice;
  readonly kind: Kind;
}

/** One commit as sent: a unique object per call, so decisions map back to it. */
interface Plan {
  readonly id: string | null;
  readonly kind: Kind;
}

const workspaceId = WorkspaceId.make("ws-pbt");

let eventCounter = 0;

const eventFor = (target: Target): DomainEvent => {
  const n = ++eventCounter;

  return target === null
    ? DomainEvent.cases.WorkspaceUpdated.make({
        workspace: new Workspace({
          id: workspaceId,
          path: "/pbt",
          name: `w${n}`,
          isGitRepo: false,
          worktreeRoot: "/pbt.worktrees",
          hidden: false,
          registeredAt: "2026-09-28T00:00:00.000Z",
        }),
      })
    : DomainEvent.cases.SessionRenamed.make({ sessionId: SessionId.make(target), title: `t${n}` });
};

const asTarget = (sessionId: string): Target =>
  sessionId === "s1" || sessionId === "s2" ? sessionId : null;

const targetOf = (envelope: EventEnvelope): Target =>
  Predicate.isTagged(envelope.event, "SessionRenamed") ? asTarget(envelope.event.sessionId) : null;

/** The stream a subscriber to `target` follows (null: the Host stream). */
const sessionOfTarget = (target: Target): SessionId | null =>
  target === null ? null : SessionId.make(target);

/** What the runs reached, printed with POLARIS_PBT_STATS=1 (to check the generators still reach it). */
const reached = {
  bursts: 0,
  multiDecisionBursts: 0,
  duplicatesAnswered: 0,
  rejections: 0,
  defects: 0,
  drops: 0,
  crashesMidBurst: 0,
  decidedThenLostInCrash: 0,
  decidedAndKeptInCrash: 0,
};

// ── Reference model ─────────────────────────────────────────────────────────

interface RefEvent {
  readonly seq: number;
  readonly target: Target;
  readonly commandId: string | null;
}

type Receipt =
  | { readonly tag: "applied"; readonly sequence: number | null }
  | { readonly tag: "rejected" }
  /** Decided just before a crash: whether its transaction committed is not known. */
  | { readonly tag: "unknown" };

interface Model {
  readonly log: Array<RefEvent>;
  readonly receipts: Map<string, Receipt>;
  /** The command each id stands for (a retry sends the same command). */
  readonly kinds: Map<string, Kind>;
  readonly ids: Array<string>;
  nextId: number;
}

type Expected =
  | { readonly tag: "committed"; readonly sequences: ReadonlyArray<number> }
  | { readonly tag: "duplicate"; readonly sequence: number | null }
  | { readonly tag: "rejected" }
  | { readonly tag: "defect" }
  /** A duplicate of an id whose receipt was unknown: whatever the store says, learned. */
  | { readonly tag: "learn" };

const newModel = (): Model => ({
  log: [],
  receipts: new Map(),
  kinds: new Map(),
  ids: [],
  nextId: 0,
});

const streamSeqs = (log: ReadonlyArray<RefEvent>, target: Target | "all") =>
  log.flatMap((e) => (target === "all" || e.target === target ? [e.seq] : []));

/** Apply one decision, in the order the store took them. */
const applyDecision = (model: Model, plan: Plan, modelSeq: number): Expected => {
  if (modelSeq !== model.log.length) {
    throw new Error(
      `${plan.id ?? "daemon"} was decided against sequence ${modelSeq}, expected ${model.log.length}`
    );
  }

  if (plan.id !== null) {
    const receipt = model.receipts.get(plan.id);

    if (receipt !== undefined && receipt.tag !== "unknown") {
      throw new Error(`${plan.id} was decided again although it has a receipt`);
    }
  }

  switch (plan.kind.tag) {
    case "append": {
      const sequences: Array<number> = [];

      for (const target of plan.kind.targets) {
        const seq = model.log.length + 1;
        model.log.push({ seq, target, commandId: plan.id });
        sequences.push(seq);
      }

      if (plan.id !== null) {
        model.receipts.set(plan.id, { tag: "applied", sequence: sequences.at(-1) ?? null });
      }

      return { tag: "committed", sequences };
    }

    case "empty":
      if (plan.id !== null) model.receipts.set(plan.id, { tag: "applied", sequence: null });

      return { tag: "committed", sequences: [] };
    case "reject":
      if (plan.id !== null) model.receipts.set(plan.id, { tag: "rejected" });

      return { tag: "rejected" };
    case "defect":
      return { tag: "defect" };
  }
};

const expectedFromReceipt = (receipt: Receipt | undefined, plan: Plan): Expected => {
  if (receipt === undefined)
    throw new Error(`${plan.id} was answered without a decision or receipt`);

  if (receipt.tag === "unknown") return { tag: "learn" };

  return receipt.tag === "rejected"
    ? { tag: "rejected" }
    : { tag: "duplicate", sequence: receipt.sequence };
};

type Outcome = Exit.Exit<CommitResult, unknown>;

/** Its receipt was unknown after a crash; the store's answer says what it was. */
const learnOutcome = (plan: Plan, exit: Outcome, model: Model, label: string) => {
  if (Exit.isSuccess(exit) && Predicate.isTagged(exit.value, "Duplicate")) {
    model.receipts.set(plan.id!, { tag: "applied", sequence: exit.value.sequence });
  } else if (Exit.isFailure(exit)) {
    model.receipts.set(plan.id!, { tag: "rejected" });
  } else {
    throw new Error(`${label}: unexpected ${JSON.stringify(exit)}`);
  }
};

const expectCommitted = (sequences: ReadonlyArray<number>, exit: Outcome, label: string) => {
  if (!Exit.isSuccess(exit) || !Predicate.isTagged(exit.value, "Committed")) {
    throw new Error(`${label}: expected Committed, got ${String(exit)}`);
  }

  expect(exit.value.envelopes.map((e): number => e.sequence)).toEqual([...sequences]);
  const sequence: number | null = exit.value.sequence;
  expect(sequence).toBe(sequences.at(-1) ?? null);
};

const expectDuplicate = (expected: number | null, exit: Outcome, label: string) => {
  reached.duplicatesAnswered++;

  if (!Exit.isSuccess(exit) || !Predicate.isTagged(exit.value, "Duplicate")) {
    throw new Error(`${label}: expected Duplicate, got ${String(exit)}`);
  }

  const sequence: number | null = exit.value.sequence;
  expect(sequence).toBe(expected);
};

const expectRejected = (plan: Plan, exit: Outcome, label: string) => {
  reached.rejections++;
  const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();

  if (Option.isNone(error) || !(error.value instanceof CommandRejected)) {
    throw new Error(`${label}: expected CommandRejected, got ${String(exit)}`);
  }

  const commandId: string = error.value.commandId;
  expect(commandId).toBe(plan.id!);
};

const expectDefect = (exit: Outcome, label: string) => {
  reached.defects++;

  if (!Exit.isFailure(exit) || !Cause.hasDies(exit.cause)) {
    throw new Error(`${label}: expected a defect, got ${String(exit)}`);
  }
};

const checkOutcome = (plan: Plan, expected: Expected, exit: Outcome, model: Model) => {
  const label = `${plan.id ?? "daemon"} (${plan.kind.tag})`;

  switch (expected.tag) {
    case "learn":
      return learnOutcome(plan, exit, model, label);
    case "committed":
      return expectCommitted(expected.sequences, exit, label);
    case "duplicate":
      return expectDuplicate(expected.sequence, exit, label);
    case "rejected":
      return expectRejected(plan, exit, label);
    case "defect":
      return expectDefect(exit, label);
  }
};

// ── The real system ─────────────────────────────────────────────────────────

interface Subscriber {
  readonly target: Target;
  readonly gate: Latch.Latch;
  last: number;
  readonly seen: Array<number>;
  drops: number;
  readonly errors: Array<string>;
  fiber: Fiber.Fiber<unknown, unknown> | null;
}

class World {
  runtime: ManagedRuntime.ManagedRuntime<EventStore, never> | null = null;
  readonly directory = tempDirectory(join(tmpdir(), "polaris-pbt-store-"));
  readonly filename = join(this.directory, "state.sqlite");

  constructor(
    readonly capacity: number,
    readonly subscribers: ReadonlyArray<Subscriber>
  ) {}

  get rt() {
    if (this.runtime === null) throw new Error("the Daemon is down");

    return this.runtime;
  }

  async open() {
    this.runtime = ManagedRuntime.make(
      EventStore.layerSqlite(this.filename).pipe(
        Layer.provide(Layer.succeed(StoreConfig)({ subscriberCapacity: this.capacity }))
      )
    );
    const store = await this.rt.runPromise(Effect.map(EventStore, (s) => s));

    for (const sub of this.subscribers) sub.fiber = this.rt.runFork(follow(store, sub));
  }

  /** The Daemon goes away: its subscribers' connections with it. */
  async crash() {
    const runtime = this.rt;
    this.runtime = null;

    for (const sub of this.subscribers) {
      if (sub.fiber !== null) await Effect.runPromise(Fiber.interrupt(sub.fiber));
      sub.fiber = null;
    }

    await runtime.dispose();
  }

  store<A, E>(f: (store: EventStore["Service"]) => Effect.Effect<A, E>) {
    return this.rt.runPromise(Effect.flatMap(EventStore, f));
  }

  /** Every committed event, from the database. */
  async readLog(): Promise<Array<RefEvent>> {
    return this.store((store) =>
      Effect.gen(function* () {
        const model = yield* store.model;
        const events = yield* store.readEvents({ after: 0, upTo: model.sequence, sessionId: null });

        return events.map((e): RefEvent => ({
          seq: e.sequence,
          target: targetOf(e),
          commandId: e.commandId,
        }));
      })
    );
  }
}

/**
 * A reader of the store's contract, as the Engine's streams use it: subscribe,
 * read the cut, replay `(last, cut]`, then live events above the cut; when the
 * live stream ends (the subscriber was dropped), start again from the last one.
 */
const follow = (store: EventStore["Service"], sub: Subscriber) =>
  Effect.gen(function* () {
    const observe = (seq: number, committedUpTo: number) => {
      if (seq <= sub.last) sub.errors.push(`saw ${seq} after ${sub.last}`);

      if (seq > committedUpTo) sub.errors.push(`saw ${seq} before it was in the model`);
      sub.last = seq;
      sub.seen.push(seq);
    };

    while (true) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sessionId = sessionOfTarget(sub.target);
          const live = yield* store.subscribe(sessionId === null ? {} : { sessionId });
          const cut = (yield* store.model).sequence;
          const replay = yield* store.readEvents({ after: sub.last, upTo: cut, sessionId });

          for (const envelope of replay) observe(envelope.sequence, cut);
          yield* live.pipe(
            Stream.runForEach((item) =>
              Effect.gen(function* () {
                yield* sub.gate.await;

                if (!Predicate.isTagged(item, "Event") || item.envelope.sequence <= cut) return;
                observe(item.envelope.sequence, (yield* store.model).sequence);
              })
            )
          );
        })
      );
      sub.drops++;
    }
  });

// ── Invariants ──────────────────────────────────────────────────────────────

const checkInvariants = async (model: Model, world: World) => {
  const log = await world.readLog();
  // The database holds exactly the reference log: gapless, nothing lost, nothing extra.
  expect(log).toEqual(model.log);

  for (const [i, e] of log.entries()) expect(e.seq).toBe(i + 1);
  expect(await world.store((s) => Effect.map(s.model, (m) => m.sequence))).toBe(log.length);
  // Each command id's events are one contiguous block (one decision).
  const blocks = new Map<string, Array<number>>();

  for (const e of log) {
    if (e.commandId === null) continue;
    blocks.set(e.commandId, [...(blocks.get(e.commandId) ?? []), e.seq]);
  }

  for (const [id, seqs] of blocks) {
    const first = seqs[0]!;
    expect({ id, seqs }).toEqual({ id, seqs: seqs.map((_, i) => first + i) });
  }

  // Every subscriber saw a prefix of its stream: no gaps, duplicates or reordering.
  for (const sub of world.subscribers) {
    expect(sub.errors).toEqual([]);
    const stream = streamSeqs(model.log, sub.target ?? "all");

    if (!isPrefix(sub.seen, stream)) {
      throw new Error(
        `subscriber ${sub.target ?? "all"} saw ${sub.seen.join(",")} of ${stream.join(",")}`
      );
    }
  }
};

// ── fast-check commands ─────────────────────────────────────────────────────

type Cmd = fc.AsyncCommand<Model, World>;

/** Every step is followed by the invariants. */
abstract class Step implements Cmd {
  check = () => true;
  abstract step(model: Model, world: World): Promise<void>;
  async run(model: Model, world: World) {
    await this.step(model, world);
    await checkInvariants(model, world);
  }
}

const resolveId = (choice: IdChoice, model: Model, previous: Plan | undefined, kind: Kind) => {
  switch (choice.tag) {
    case "daemon":
      // The Daemon's own decisions never reject or throw.
      if (kind.tag === "append" || kind.tag === "empty") return { id: null, kind };
      break;
    case "again":
      if (previous?.id != null) return previous;
      break;
    case "retry": {
      // Only ids whose command is remembered: a defect leaves no receipt to retry against.
      const candidates = model.ids.filter((id) => model.kinds.get(id)!.tag !== "defect");

      if (candidates.length > 0) {
        const id = candidates[choice.pick % candidates.length]!;

        return { id, kind: model.kinds.get(id)! };
      }

      break;
    }

    case "fresh":
      break;
  }

  const id = `cmd-${++model.nextId}`;
  model.ids.push(id);
  model.kinds.set(id, kind);

  return { id, kind };
};

const decideFor = (plan: Plan) => {
  switch (plan.kind.tag) {
    case "append":
      return Effect.succeed(plan.kind.targets.map(eventFor));
    case "empty":
      return Effect.succeed([]);
    case "reject":
      return Effect.fail(
        new CommandRejected({ commandId: CommandId.make(plan.id!), reason: "no" })
      );
    case "defect":
      return Effect.die(new Error("the decider threw"));
  }
};

class Burst extends Step {
  constructor(
    readonly groups: ReadonlyArray<ReadonlyArray<CommitSpec>>,
    readonly scheduler: fc.Scheduler,
    /** Crash after this many groups were released (null: no crash). */
    readonly crashAfter: number | null
  ) {
    super();
  }

  override async step(model: Model, world: World) {
    let previous: Plan | undefined;

    const plans = this.groups.map((group) =>
      group.map((spec) => {
        const plan: Plan = { ...resolveId(spec.id, model, previous, spec.kind) };
        previous = plan;

        return plan;
      })
    );

    const decided: Array<{ readonly plan: Plan; readonly modelSeq: number }> = [];
    const exits = new Map<Plan, Outcome>();
    const sent: Array<Plan> = [];
    const runtime = world.rt;

    const commitOne = (plan: Plan) => {
      sent.push(plan);

      return runtime
        .runPromiseExit(
          Effect.gen(function* () {
            const store = yield* EventStore;

            const result = yield* store.commit({
              commandId: plan.id === null ? null : CommandId.make(plan.id),
              decide: (current) => {
                decided.push({ plan, modelSeq: current.sequence });

                return decideFor(plan);
              },
            });

            // The answer comes only once the events are in the database.
            if (result.sequence !== null) {
              const upTo: number = result.sequence;
              const rows = yield* store.readEvents({ after: upTo - 1, upTo, sessionId: null });

              if (rows.length !== 1) return yield* Effect.die(new Error("answered before commit"));
            }

            return result;
          })
        )
        .then((exit) => void exits.set(plan, exit));
    };

    const released: Array<Promise<unknown>> = [];

    for (const group of plans) {
      released.push(
        this.scheduler
          .schedule(Promise.resolve(), `group of ${group.length}`)
          .then(() => (world.runtime === runtime ? Promise.all(group.map(commitOne)) : undefined))
      );
    }

    if (this.crashAfter === null) {
      await this.scheduler.waitIdle();
      await Promise.all(released);
      reconcile(model, decided, exits);

      return;
    }

    const upTo = Math.min(this.crashAfter ?? 0, this.scheduler.count());

    if (upTo > 0) await this.scheduler.waitNext(upTo);
    reached.crashesMidBurst++;
    await world.crash();
    await this.scheduler.waitIdle();
    await world.open();
    await afterCrash(model, world, decided);
  }

  override toString() {
    const groups = this.groups
      .map((g) => g.map((s) => `${s.id.tag}:${s.kind.tag}`).join("+"))
      .join(" | ");

    return `Burst(${groups}${this.crashAfter === null ? "" : `, crash after ${this.crashAfter}`})`;
  }
}

/** Replay the store's decisions in order, then check every answer against them. */
const reconcile = (
  model: Model,
  decided: ReadonlyArray<{ readonly plan: Plan; readonly modelSeq: number }>,
  exits: ReadonlyMap<Plan, Outcome>
) => {
  reached.bursts++;

  if (decided.length > 1) reached.multiDecisionBursts++;
  const expected = new Map<Plan, Expected>();

  for (const { plan, modelSeq } of decided) {
    if (expected.has(plan)) throw new Error(`${plan.id} was decided twice`);
    expected.set(plan, applyDecision(model, plan, modelSeq));
  }

  for (const [plan, exit] of exits) {
    const e =
      expected.get(plan) ??
      (plan.id === null
        ? (() => {
            throw new Error("a Daemon commit was never decided");
          })()
        : expectedFromReceipt(model.receipts.get(plan.id), plan));

    checkOutcome(plan, e, exit, model);
  }
};

/** The block of `extra` from `at` if it is exactly `plan`'s events, else null. */
const committedBlock = (plan: Plan, extra: ReadonlyArray<RefEvent>, at: number) => {
  const targets = plan.kind.tag === "append" ? plan.kind.targets : [];
  const block = extra.slice(at, at + targets.length);

  const committed =
    targets.length > 0 &&
    block.length === targets.length &&
    block.every((e, i) => e.commandId === plan.id && e.target === targets[i]);

  return committed ? block : null;
};

/** A decision lost in the crash: an empty or rejected one may have left only its receipt. */
const lostInCrash = (model: Model, plan: Plan) => {
  if (plan.kind.tag === "append") reached.decidedThenLostInCrash++;

  if (plan.id === null || model.receipts.has(plan.id) || plan.kind.tag === "defect") return;

  // An append that is not in the log has no receipt (events and receipt share one transaction).
  if (plan.kind.tag !== "append") model.receipts.set(plan.id, { tag: "unknown" });
};

/**
 * After a crash mid-burst: the database must still hold everything committed
 * before, plus, for each decision taken before the crash, its events in full
 * or none of them, in decision order.
 */
const afterCrash = async (
  model: Model,
  world: World,
  decided: ReadonlyArray<{ readonly plan: Plan; readonly modelSeq: number }>
) => {
  const log = await world.readLog();
  expect(log.slice(0, model.log.length)).toEqual(model.log);
  const extra = log.slice(model.log.length);
  let at = 0;

  for (const { plan } of decided) {
    const block = committedBlock(plan, extra, at);

    if (block === null) {
      lostInCrash(model, plan);
      continue;
    }

    reached.decidedAndKeptInCrash++;
    at += block.length;

    for (const e of block) model.log.push(e);

    if (plan.id !== null) {
      model.receipts.set(plan.id, { tag: "applied", sequence: block.at(-1)!.seq });
    }
  }

  if (at !== extra.length) {
    throw new Error(`events after the crash that no decision explains: ${JSON.stringify(extra)}`);
  }
};

class Crash extends Step {
  override async step(_model: Model, world: World) {
    await world.crash();
    await world.open();
  }
  override toString = () => "Crash";
}

class Pause extends Step {
  constructor(
    readonly index: number,
    readonly paused: boolean
  ) {
    super();
  }
  override async step(_model: Model, world: World) {
    const sub = world.subscribers[this.index % world.subscribers.length]!;

    if (this.paused) Latch.closeUnsafe(sub.gate);
    else Latch.openUnsafe(sub.gate);
  }
  override toString = () => `${this.paused ? "Pause" : "Resume"}(${this.index})`;
}

/** Ephemeral output alone never drops a subscriber. */
class Ephemeral extends Step {
  constructor(
    readonly target: "s1" | "s2",
    readonly count: number
  ) {
    super();
  }
  override async step(_model: Model, world: World) {
    const target = SessionId.make(this.target);
    const count = this.count;

    const [before, after] = await world.store((store) =>
      Effect.gen(function* () {
        // No yield between the counts: publishing is synchronous, so only it could drop anyone.
        const before = yield* store.subscriberCount;

        for (let i = 0; i < count; i++) {
          yield* store.publishEphemeral(
            LiveItem.Delta({
              sessionId: target,
              turnId: TurnId.make("t-pbt"),
              itemId: "m",
              field: "text",
              text: `${i}`,
              subagentId: null,
            })
          );
        }

        return [before, yield* store.subscriberCount] as const;
      })
    );

    expect(after).toBe(before);
  }
  override toString = () => `Ephemeral(${this.target} x${this.count})`;
}

// ── Arbitraries ─────────────────────────────────────────────────────────────

const targetArb: fc.Arbitrary<Target> = fc.constantFrom<Target>("s1", "s2", null);

const kindArb: fc.Arbitrary<Kind> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc
      .array(targetArb, { minLength: 1, maxLength: 3 })
      .map((targets) => ({ tag: "append" as const, targets })),
  },
  { weight: 2, arbitrary: fc.constant({ tag: "reject" as const }) },
  { weight: 1, arbitrary: fc.constant({ tag: "empty" as const }) },
  { weight: 1, arbitrary: fc.constant({ tag: "defect" as const }) }
);

const idArb: fc.Arbitrary<IdChoice> = fc.oneof(
  { weight: 5, arbitrary: fc.constant({ tag: "fresh" as const }) },
  { weight: 3, arbitrary: fc.nat(20).map((pick) => ({ tag: "retry" as const, pick })) },
  { weight: 1, arbitrary: fc.constant({ tag: "again" as const }) },
  { weight: 1, arbitrary: fc.constant({ tag: "daemon" as const }) }
);

const commitArb = fc.record({ id: idArb, kind: kindArb });

const commandArbs: Array<fc.Arbitrary<Cmd>> = [
  fc
    .tuple(
      fc.array(fc.array(commitArb, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 4 }),
      fc.scheduler()
    )
    .map(([groups, scheduler]) => new Burst(groups, scheduler, null)),
  fc
    .tuple(
      fc.array(fc.array(commitArb, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 3 }),
      fc.scheduler(),
      fc.nat(3)
    )
    .map(([groups, scheduler, n]) => new Burst(groups, scheduler, n)),
  fc.constant(new Crash()),
  fc.tuple(fc.nat(5), fc.boolean()).map(([i, paused]) => new Pause(i, paused)),
  fc
    .tuple(fc.constantFrom<"s1" | "s2">("s1", "s2"), fc.integer({ min: 1, max: 12 }))
    .map(([t, n]) => new Ephemeral(t, n)),
];

const subscriberArb = fc.record({ target: targetArb, paused: fc.boolean() });

// ── The property ────────────────────────────────────────────────────────────

const RUNS = pbtRuns(25);

describe("EventStore, model-based", () => {
  test(
    "group commit, receipts, bounded subscribers and crashes match the reference model",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 4 }),
          fc.array(subscriberArb, { minLength: 1, maxLength: 4 }),
          fc.commands(commandArbs, { maxCommands: 14 }),
          async (capacity, subs, commands) => {
            const subscribers: Array<Subscriber> = subs.map(({ target, paused }) => ({
              target,
              gate: Latch.makeUnsafe(!paused),
              last: 0,
              seen: [],
              drops: 0,
              errors: [],
              fiber: null,
            }));

            const world = new World(capacity, subscribers);
            const model = newModel();

            try {
              await world.open();
              await fc.asyncModelRun(() => ({ model, real: world }), commands);

              // Liveness: with every subscriber reading again, each catches up.
              for (const sub of subscribers) Latch.openUnsafe(sub.gate);

              for (const sub of subscribers) {
                const stream = streamSeqs(model.log, sub.target ?? "all");
                await eventually(`subscriber ${sub.target ?? "all"} catches up`, () =>
                  isPrefix(stream, sub.seen)
                );
                expect(sub.seen).toEqual(stream);
              }
            } finally {
              for (const sub of subscribers) reached.drops += sub.drops;

              try {
                if (world.runtime !== null) await world.crash();
              } finally {
                removeTempDirectory(world.directory);
              }
            }
          }
        ),
        { numRuns: RUNS, ...pbtSeed() }
      );

      if (process.env.POLARIS_PBT_STATS === "1") console.info("EventStore PBT reached", reached);
    },
    pbtTimeout(RUNS, 400)
  );
});
