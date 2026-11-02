/**
 * Where a working Attempt's worker is between dispatch and its work (ENG-264), derived from
 * folded facts only: its setup card, its `__workers` lease or queue entry, and its Session's Turns.
 * The Desktop App's worker row and the Lead's `status` read the same phase.
 */

/** A worker holding a slot this long with no first Turn is stalled, not starting. */
export const STALL_AFTER_MS = 60_000;

/** A worker's Waiting on Background Work (`WorkerWaiting`), as `workerPhase` reads it. */
export interface PhaseWaiting {
  readonly tasks: ReadonlyArray<{
    readonly kind: "subagent" | "command";
    readonly description: string;
  }>;
  readonly on: string | null;
  readonly since: string;
  /** Unix epoch milliseconds; at and past it the wait no longer holds. */
  readonly until: number;
}

export interface WorkerPhaseInput {
  /** This Attempt's worktree setup, when one ran for it or ahead of it (a deferred setup). */
  readonly setup: {
    readonly status: "running" | "completed" | "failed";
    readonly startedAt: string;
    readonly endedAt: string | null;
  } | null;
  /** Its `__workers` request: queued since, or held (granted) since; null when neither is known. */
  readonly slot:
    | { readonly kind: "queued"; readonly since: string }
    | { readonly kind: "held"; readonly since: string }
    | null;
  /** Its first Turn (`${attempt.id}:start`) has started; null when the Daemon doesn't say. */
  readonly firstTurn: boolean | null;
  /** Its Session has a Turn in flight; null when unknown. */
  readonly turnInFlight: boolean | null;
  /** The Attempt's own `startedAt`. */
  readonly startedAt: string;
  readonly now: number;
  /** The Daemon's `WorkerLiveness.waiting`; absent or null when it isn't waiting. */
  readonly waiting?: PhaseWaiting | null;
}

export type WorkerPhase =
  | { readonly kind: "setup-running"; readonly since: string }
  | { readonly kind: "setup-failed" }
  | { readonly kind: "waiting-for-slot"; readonly since: string }
  /** No first Turn yet and still within the grace period; `afterTurn` while an older Turn runs. */
  | {
      readonly kind: "starting";
      readonly since: string;
      readonly setupDone: boolean;
      readonly afterTurn: boolean;
    }
  /** Holds a slot with no first Turn and nothing running, past the grace period. */
  | { readonly kind: "stalled"; readonly since: string; readonly setupDone: boolean }
  | { readonly kind: "working" }
  /** Its Turn ended with background work out, and the wait still holds (ENG-742). */
  | { readonly kind: "waiting-on-background"; readonly waiting: PhaseWaiting }
  /** Its first Turn ran; no Turn is in flight now. */
  | { readonly kind: "idle" }
  /** An older Daemon that doesn't report the first Turn. */
  | { readonly kind: "unknown" };

const later = (a: string, b: string | null) => (b !== null && b > a ? b : a);

const notStarted = (input: WorkerPhaseInput, setupDone: boolean): WorkerPhase => {
  const { slot } = input;
  const settled = later(input.startedAt, setupDone ? (input.setup?.endedAt ?? null) : null);
  const since = slot?.kind === "held" ? later(settled, slot.since) : settled;

  if (input.turnInFlight === true) return { kind: "starting", since, setupDone, afterTurn: true };

  return slot?.kind === "held" && input.now - Date.parse(since) >= STALL_AFTER_MS
    ? { kind: "stalled", since, setupDone }
    : { kind: "starting", since, setupDone, afterTurn: false };
};

const afterFirstTurn = (input: WorkerPhaseInput): WorkerPhase => {
  if (input.turnInFlight !== false) return { kind: "working" };
  const { waiting } = input;

  return waiting != null && input.now < waiting.until
    ? { kind: "waiting-on-background", waiting }
    : { kind: "idle" };
};

/** The phase of a working Attempt's worker; callers decide copy, glyph and actions. */
export const workerPhase = (input: WorkerPhaseInput): WorkerPhase => {
  const { setup, slot } = input;

  if (setup?.status === "running" && setup.startedAt >= input.startedAt)
    return { kind: "setup-running", since: setup.startedAt };

  if (setup?.status === "failed" && setup.startedAt >= input.startedAt)
    return { kind: "setup-failed" };

  if (slot?.kind === "queued") return { kind: "waiting-for-slot", since: slot.since };

  if (input.firstTurn === true) return afterFirstTurn(input);

  if (input.firstTurn === null) return { kind: "unknown" };

  return notStarted(input, setup?.status === "completed");
};
