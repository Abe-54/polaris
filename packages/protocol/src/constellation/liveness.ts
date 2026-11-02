import { Schema } from "effect";
import { Timestamp, TurnId } from "../ids.ts";

const epochMs = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export class WorkerActivity extends Schema.Class<WorkerActivity>("ConstellationWorkerActivity")({
  itemId: Schema.String,
  turnId: TurnId,
  /** Command text or tool name, observed from the worker's own Harness events. */
  command: Schema.String,
  /** Unix epoch milliseconds; Clients derive elapsed time when rendering. */
  startedAt: epochMs,
}) {}

/** `BackgroundTask`'s fields, kept here: `../domain.ts` imports this module. */
const WaitedTask = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["subagent", "command"]),
  description: Schema.String,
});

/**
 * A worker that ended its Turn with background work out (ENG-742): Waiting on Background Work,
 * neither stopped nor stalled. The Daemon derives it from folded events.
 */
export class WorkerWaiting extends Schema.Class<WorkerWaiting>("ConstellationWorkerWaiting")({
  /** The background tasks its Harness will wake it for; empty for a wait it declared. */
  tasks: Schema.Array(WaitedTask),
  /** What the worker said it waits on (the `wait` tool); null when its Harness reported the tasks. */
  on: Schema.NullOr(Schema.String),
  since: Timestamp,
  /** Unix epoch milliseconds; past it a silent worker is nudged and can stall. */
  until: epochMs,
}) {}

/** Observed facts for one Attempt; null observations are unknown, never invented progress. */
export class WorkerLiveness extends Schema.Class<WorkerLiveness>("ConstellationWorkerLiveness")({
  current: Schema.NullOr(WorkerActivity),
  /** Unix epoch milliseconds of the latest main-session item update or output. */
  lastOutputAt: Schema.NullOr(epochMs),
  contextPercent: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  /** Inputs queued by the owning Engine's delivery journal. */
  queuedInput: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /**
   * Whether the worker's Session has a Turn in flight; absent from an older Daemon.
   * A working Attempt without one is waiting, never "working".
   */
  activeTurn: Schema.optionalKey(Schema.Boolean),
  /** Whether this Attempt's first Turn (its brief) has started; absent from an older Daemon. */
  firstTurn: Schema.optionalKey(Schema.Boolean),
  /** Waiting on Background Work, else null; absent from an older Daemon. */
  waiting: Schema.optionalKey(Schema.NullOr(WorkerWaiting)),
}) {}
