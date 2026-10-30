/**
 * The pure Agent Session lifecycle decider. It derives snapshots from the event log,
 * then emits domain events and effects for one input (see README.md).
 */
import {
  backgroundStopRefusal,
  commandBackgroundRefusal,
  backgroundTasksChanged,
  idleStopEffect,
  backgroundIdleStop,
} from "./session.backgroundTasks.ts";
import { deferredDelivery, refusedInput } from "./session.deferred.ts";
import { harnessTurn, takesTurn, turnRefusal } from "./session.turns.ts";
import { modelChanged } from "./session.model.ts";
import { DomainEvent, type SessionState, type Turn } from "@polaris/protocol";
import { Predicate, Result } from "effect";
import { createMachine, isUnhandled, transition, types } from "xstate";
import { lastTurn, patchTurn, type SessionRecord, workingTurn } from "../store/model.ts";
import {
  eventSchemas,
  normalizedInput,
  isEmitted,
  type Emitted,
  type SessionEffect,
  type SessionInput,
} from "./session.inputs.ts";
import { interruptedSetup, setupChanged } from "./session.setup.ts";
import { acceptTurns, lastIsAccepted } from "./session.accept.ts";
import { endBackgroundWork, subagentEnded, subagentStarted } from "./session.subagents.ts";
import { backToWork, decisionRefusal, withdrawn } from "./session.approvals.ts";
import {
  endTurn,
  foldEach,
  RECOVERY_REASON,
  stateChanged,
  withdrawPending,
} from "./session.events.ts";

export type { SessionEffect, SessionInput } from "./session.inputs.ts";

interface Context {
  /** The folded session; null before it exists. */
  readonly record: SessionRecord | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export { stateChanged } from "./session.events.ts";

const need = (context: Context): SessionRecord => {
  if (context.record === null) throw new Error("the session machine needs a session");

  return context.record;
};

type Enqueue = { emit: (emitted: Emitted) => void };

/**
 * How XState v6 transition functions read here: returning `undefined` means
 * "not taken", and the event bubbles to the machine-level default; returning
 * an object (even `HANDLED`, no target) takes the transition and stops it.
 */
const HANDLED = {};

/**
 * Emit `events`, then (with `enter`) the Session State change they lead to,
 * and move to the state the fold of all of them gives. A state change
 * re-enters its state, so entry effects run for every `SessionStateChanged`.
 * With nothing to emit it is still taken (`HANDLED`).
 */
const settle = (
  enq: Enqueue,
  record: SessionRecord | null,
  events: ReadonlyArray<DomainEvent>,
  enter?: {
    readonly state: SessionState;
    readonly reason?: string | null;
    readonly resetsAt?: string | null;
  }
) => {
  const sessionId =
    record?.session.id ?? (events[0]?._tag === "SessionCreated" ? events[0].session.id : undefined);

  if (sessionId === undefined) return undefined;

  const all = enter
    ? [...events, stateChanged(sessionId, enter.state, enter.reason, enter.resetsAt)]
    : events;

  if (all.length === 0) return HANDLED;

  const folded = foldEach(sessionId, record ?? undefined, all);

  for (const event of folded.events) enq.emit({ type: "domain", event });
  const next = folded.record!;
  const moved = enter !== undefined || next.session.state !== record?.session.state;

  const context = { record: next };

  return moved ? { target: `#${next.session.state}`, reenter: true, context } : { context };
};

const reject = (enq: Enqueue, reason: string | null) => {
  if (reason !== null) enq.emit({ type: "rejected", reason });
};

// ── Machine ─────────────────────────────────────────────────────────────────

/** A new Turn (or the continued one) starts: Working if the Harness is live, else Starting. */
const sendTurn = (
  { context, event }: { context: Context; event: { type: "turn.send"; turn: Turn } },
  enq: Enqueue
) => {
  const record = need(context);

  if (!takesTurn(record)) return undefined;

  return settle(enq, record, [DomainEvent.cases.TurnStarted.make({ turn: event.turn })], {
    state: record.session.state === "idle" ? "working" : "starting",
  });
};

const continueTurn = ({ context }: { context: Context }, enq: Enqueue) => {
  const record = need(context);
  const last = lastTurn(record);

  if (last?.status !== "interrupted" || lastIsAccepted(record) || !takesTurn(record)) {
    return undefined;
  }

  // The same Turn resumes: back to working, keeping its before-checkpoint.
  const turn = patchTurn(last, { status: "working", endedAt: null });

  return settle(enq, record, [DomainEvent.cases.TurnStarted.make({ turn })], {
    state: record.session.state === "idle" ? "working" : "starting",
  });
};

/** A Failed last Turn's prompt goes again as a new Turn, like a sent one. */
const retryTurn = (
  { context, event }: { context: Context; event: { type: "turn.retry"; turn: Turn } },
  enq: Enqueue
) => {
  if (lastTurn(need(context))?.status !== "failed") return undefined;

  return sendTurn({ context, event: { type: "turn.send", turn: event.turn } }, enq);
};

type TurnEndedInput = Extract<SessionInput, { type: "harness.turnEnded" }>;

/** The Turn's end as the Harness reports it; `withState` also leaves Working. */
const turnEnded = (
  record: SessionRecord,
  event: TurnEndedInput,
  enq: Enqueue,
  withState: boolean
) => {
  const turn = record.turns.find((t) => t.id === event.turnId);

  if (turn === undefined || turn.status !== "working") return undefined;
  const events: Array<DomainEvent> = [];

  if (event.checkpoint !== null) {
    events.push(
      DomainEvent.cases.CheckpointRecorded.make({
        sessionId: record.session.id,
        turnId: turn.id,
        ref: event.checkpoint.ref,
        commit: event.checkpoint.commit,
      })
    );
  }

  // At a usage limit the Turn stops short, like an interrupt, so Continue picks it up.
  const limited = withState && event.status === "failed" && event.limit != null;
  const status = limited ? "interrupted" : event.status;

  events.push(
    ...withdrawPending(record, "harness", "The Turn ended", turn.id),
    endTurn(turn, status, event.at, event.checkpoint?.ref ?? turn.checkpointAfter)
  );

  return settle(enq, record, events, withState ? turnEndState(event) : undefined);
};

const turnEndState = (event: TurnEndedInput) => {
  if (event.status !== "failed") return { state: "idle" } as const;

  const reason = event.error ?? "The Turn failed";

  return event.limit == null
    ? ({ state: "failed", reason } as const)
    : ({ state: "limited", reason, resetsAt: event.limit.resetsAt } as const);
};

type ExitedInput = Extract<SessionInput, { type: "harness.exited" }>;

/** The Harness went away: its Turn ends, its requests go, the session Fails or goes Dormant. */
const exited = (record: SessionRecord, event: ExitedInput, enq: Enqueue, withState: boolean) => {
  const turn = workingTurn(record);
  const reason = event.error ?? "The Harness exited";

  const events = [
    ...endBackgroundWork(record, event.at),
    ...(turn ? [endTurn(turn, event.error ? "failed" : "interrupted", event.at)] : []),
    ...withdrawPending(record, "harness", reason),
  ];

  return settle(
    enq,
    record,
    events,
    !withState
      ? undefined
      : event.error !== null
        ? { state: "failed", reason: event.error }
        : { state: "dormant", reason: "harness-exited" }
  );
};

type RecoverInput = Extract<SessionInput, { type: "daemon.recover" }>;

/**
 * The recovery rule, for a session whose Harness went away with the Daemon
 * (restart, upgrade): a working Turn becomes Interrupted and the session Needs
 * You (reason `interrupted`) so the user decides with Continue; a Turn is
 * never continued automatically. Pending approvals are withdrawn. Failed stays
 * Failed, a Needs You still waiting on Continue stays, other states go Dormant.
 */
const recover = (record: SessionRecord, event: RecoverInput, enq: Enqueue) => {
  const turn = workingTurn(record);
  const { state } = record.session;
  const stoppedFor = event.stoppedFor ?? event.cause;
  const setup = interruptedSetup(record, event.at, stoppedFor);

  if (setup.length > 0) return settle(enq, record, setup);

  if (state === "dormant") return HANDLED;

  const events = [
    ...endBackgroundWork(record, event.at),
    ...(turn ? [endTurn(turn, "interrupted", event.at)] : []),
    ...withdrawPending(record, "daemon", RECOVERY_REASON[stoppedFor]),
  ];

  if (turn !== undefined) {
    return settle(enq, record, events, { state: "needs-you", reason: "interrupted" });
  }

  if (
    state === "failed" ||
    state === "limited" ||
    (state === "needs-you" && lastTurn(record)?.status === "interrupted")
  ) {
    return settle(enq, record, events);
  }

  return settle(enq, record, events, {
    state: "dormant",
    reason: stoppedFor === "restart" ? "daemon-restart" : "daemon-upgrade",
  });
};

/** Taken, with no change: a state that returns it stops the event from bubbling to the defaults. */
const ignore = () => HANDLED;

/** Interrupt with no Harness running the Turn: end it here (and go Dormant, `withState`). */
const interruptUnattended = (
  record: SessionRecord,
  at: string,
  enq: Enqueue,
  withState: boolean
) => {
  const turn = workingTurn(record);

  if (turn === undefined) return undefined;

  return settle(
    enq,
    record,
    [
      ...endBackgroundWork(record, at),
      ...withdrawPending(record, "daemon", "Interrupted"),
      endTurn(turn, "interrupted", at),
    ],
    withState ? { state: "dormant" } : undefined
  );
};

/**
 * Archive, in every state but Archived: refused while a Turn is in flight
 * (the user interrupts it first, from Polaris or the terminal UI), so an
 * Archived session never holds a working Turn. A request still pending with
 * no Turn in flight (only in logs from before this rule) is withdrawn.
 */
const archive = ({ context, event }: { context: Context; event: { at: string } }, enq: Enqueue) => {
  const record = need(context);

  if (workingTurn(record) !== undefined) {
    return reject(enq, "interrupt the Turn in flight before archiving");
  }

  return settle(
    enq,
    record,
    [
      ...endBackgroundWork(record, event.at),
      ...withdrawPending(record, "daemon", "The session was archived"),
    ],
    { state: "archived" }
  );
};

type ApprovalRequestedInput = Extract<SessionInput, { type: "harness.approvalRequested" }>;

/**
 * A Harness asks for approval: recorded only for the Turn in flight. A request
 * for any other Turn (one that ended, a stale or misbehaving Harness) is
 * ignored, as `turnEnded` ignores a Turn that is not working, so nothing is
 * ever pending without a Turn to answer it for. `enter` is the state it moves
 * the session to, if any.
 */
const approvalRequested = (
  record: SessionRecord,
  event: ApprovalRequestedInput,
  enq: Enqueue,
  enter?: "needs-you"
) => {
  if (workingTurn(record)?.id !== event.request.turnId) return HANDLED;

  return settle(
    enq,
    record,
    [DomainEvent.cases.ApprovalRequested.make({ request: event.request })],
    enter === undefined ? undefined : { state: enter }
  );
};

export const sessionMachine = createMachine({
  id: "session",
  schemas: {
    context: types<Context>(),
    events: eventSchemas,
    emitted: {
      domain: types<{ event: DomainEvent }>(),
      rejected: types<{ reason: string }>(),
      effect: types<{ effect: SessionEffect }>(),
    },
  },
  context: { record: null },
  initial: "new",
  // Defaults for every existing session; states override what they accept.
  on: {
    "session.start": ({ event }, enq) => reject(enq, `session ${event.session.id} already exists`),
    "session.fork": ({ event }, enq) => reject(enq, `session ${event.session.id} already exists`),
    "turn.deliver": ({ context, event }, enq) => {
      if (context.record === null) {
        for (const domain of refusedInput(undefined, event, "the Session was deleted"))
          enq.emit({ type: "domain", event: domain });

        return HANDLED;
      }

      const record = context.record;
      const delivery = deferredDelivery(record, event);

      if (delivery.waiting !== null) {
        enq.emit({ type: "effect", effect: { type: "waitForTurn", turnId: delivery.waiting } });

        return HANDLED;
      }

      if (delivery.refusal === null) {
        const started = sendTurn({ context, event: { type: "turn.send", turn: event.turn } }, enq);

        if (started !== undefined) return started;
      }

      return settle(
        enq,
        record,
        refusedInput(record, event, delivery.refusal ?? turnRefusal(record, "send"))
      );
    },
    "turn.send": ({ context }, enq) => reject(enq, turnRefusal(need(context), "send")),
    "turn.continue": ({ context }, enq) => reject(enq, turnRefusal(need(context), "continue")),
    "turn.retry": ({ context }, enq) => reject(enq, turnRefusal(need(context), "retry")),
    "turn.steer": ({ context, event }, enq) => {
      const record = need(context);

      if (workingTurn(record) === undefined || record.session.state === "in-terminal") {
        return reject(enq, "there is no Turn in flight to steer");
      }

      if (!event.canSteer)
        return reject(enq, `${record.session.harness} does not support steering`);

      if (!event.takesAttachments)
        return reject(enq, `${record.session.harness} can't take attachments in a steer`);
    },
    "background.stop": ({ context, event }, enq) =>
      reject(enq, backgroundStopRefusal(need(context), event)),
    "command.background": ({ context, event }, enq) =>
      reject(enq, commandBackgroundRefusal(need(context), event)),
    "turn.interrupt": ({ context }, enq) => {
      if (workingTurn(need(context)) === undefined) reject(enq, "there is no Turn in flight");
    },
    "approval.respond": ({ context, event }, enq) => {
      const record = need(context);

      if (!record.pending.has(event.requestId)) {
        return reject(enq, `request ${event.requestId} is already resolved`);
      }

      const refusal = decisionRefusal(record, event.requestId, event.decision);

      if (refusal !== null) return reject(enq, refusal);

      return settle(enq, record, [
        DomainEvent.cases.ApprovalResolved.make({
          sessionId: record.session.id,
          requestId: event.requestId,
          decision: event.decision,
          resolvedBy: event.resolvedBy,
        }),
      ]);
    },
    "permissionMode.set": ({ context, event }, enq) => {
      const record = need(context);

      if (record.session.permissionMode === event.permissionMode) return undefined;

      return settle(enq, record, [
        DomainEvent.cases.SessionPermissionModeChanged.make({
          sessionId: record.session.id,
          permissionMode: event.permissionMode,
        }),
      ]);
    },
    // Between Turns only; a Harness that can't switch mid-session only before it has one.
    // Between Turns only; a Harness that can't switch mid-session, only before it has one.
    "model.set": ({ context, event }, enq) => {
      const record = need(context);
      const { session } = record;

      if (workingTurn(record) !== undefined) return reject(enq, turnRefusal(record, "send"));

      if (!event.canSwitchModel && session.harnessCursor !== null) {
        return reject(enq, `${session.harness} can't switch Model mid-session; fork instead`);
      }

      const changed = modelChanged(session, event);

      return changed === null ? HANDLED : settle(enq, record, [changed]);
    },
    "turns.accept": ({ context, event }, enq) => {
      const record = need(context);
      const accepted = acceptTurns(record, event);

      return Result.isSuccess(accepted)
        ? settle(enq, record, accepted.success)
        : reject(enq, accepted.failure);
    },
    "session.archive": archive,
    "session.unarchive": (_, enq) => reject(enq, "the session is not Archived"),
    "terminal.open": ({ context }, enq) =>
      reject(enq, `the session is ${need(context).session.state}`),
    "terminal.return": (_, enq) => reject(enq, "the session is not In Terminal"),

    "harness.opened": ignore,
    "harness.resumed": ignore,
    "harness.turnStarted": ({ context, event }, enq) => {
      const started = harnessTurn(need(context), event);

      return started === null ? undefined : settle(enq, need(context), [started]);
    },
    "harness.approvalRequested": ({ context, event }, enq) =>
      approvalRequested(need(context), event, enq, "needs-you"),
    "harness.approvalWithdrawn": ({ context, event }, enq) => {
      const record = need(context);

      if (!record.pending.has(event.requestId)) return undefined;

      return settle(enq, record, [withdrawn(record, event)]);
    },
    "harness.turnEnded": ({ context, event }, enq) => turnEnded(need(context), event, enq, true),
    "harness.subagentStarted": ({ context, event }, enq) =>
      settle(enq, need(context), subagentStarted(need(context), event.subagent)),
    "harness.subagentEnded": ({ context, event }, enq) => {
      const record = need(context);
      const events = subagentEnded(record, event);

      if (events.length > 0) for (const effect of idleStopEffect(record)) enq.emit(effect);

      return settle(enq, record, events);
    },
    "harness.exited": ({ context, event }, enq) => exited(need(context), event, enq, true),
    "terminal.closed": ({ context, event }, enq) => {
      // A Turn the terminal UI left open when it closed ends Interrupted.
      const record = need(context);
      const turn = workingTurn(record);

      if (turn === undefined) return undefined;

      return settle(enq, record, [
        ...withdrawPending(record, "harness", "The terminal UI closed", turn.id),
        endTurn(turn, "interrupted", event.at),
      ]);
    },
    "idle.timeout": ignore,
    "session.setup": ({ context, event }, enq) => {
      const record = need(context);

      if (event.setup.status === "running" && !takesTurn(record))
        return reject(enq, "wait for the Session boundary before worktree setup");

      return settle(enq, record, setupChanged(record, event.setup));
    },
    "session.fail": ({ context, event }, enq) => {
      const record = need(context);
      const turn = workingTurn(record);

      return settle(
        enq,
        record,
        [
          ...endBackgroundWork(record, event.at),
          ...(turn ? [endTurn(turn, "failed", event.at)] : []),
          ...withdrawPending(record, "daemon", event.message),
        ],
        { state: "failed", reason: event.message }
      );
    },
    "turn.interruptUnattended": ({ context, event }, enq) =>
      interruptUnattended(need(context), event.at, enq, true),
    "daemon.recover": ({ context, event }, enq) => recover(need(context), event, enq),
  },
  states: {
    /** Not created yet: only StartSession and ForkSession apply. */
    new: {
      on: {
        "session.start": ({ event }, enq) =>
          settle(enq, null, [
            DomainEvent.cases.SessionCreated.make({ session: event.session }),
            DomainEvent.cases.TurnStarted.make({ turn: event.turn }),
          ]),
        "session.fork": ({ event }, enq) =>
          settle(enq, null, [DomainEvent.cases.SessionCreated.make({ session: event.session })]),
      },
    },
    /** Its Harness is being opened (or resumed) for a Turn or a return from the terminal. */
    starting: {
      id: "starting",
      on: {
        "harness.opened": ({ context }, enq) =>
          settle(enq, need(context), [], { state: "working" }),
        "harness.resumed": ({ context }, enq) => {
          const record = need(context);

          return settle(enq, record, [], {
            state: workingTurn(record) !== undefined ? "working" : "idle",
          });
        },
        "harness.turnStarted": ({ context, event }, enq) => {
          const started = harnessTurn(need(context), event);

          return started === null
            ? undefined
            : settle(enq, need(context), [started], { state: "working" });
        },
      },
    },
    /** The Harness process is known to be running. */
    live: {
      initial: "idle",
      on: {
        "harness.backgroundTasksChanged": ({ context, event }, enq) => {
          const record = need(context);

          for (const effect of idleStopEffect(record)) enq.emit(effect);

          return settle(enq, record, backgroundTasksChanged(record, event.tasks));
        },
      },
      states: {
        idle: {
          id: "idle",
          entry: ({ context }, enq) => {
            for (const effect of idleStopEffect(need(context))) enq.emit(effect);
          },
          on: {
            "turn.send": sendTurn,
            "turn.continue": continueTurn,
            "turn.retry": retryTurn,
            "terminal.open": ({ context }, enq) =>
              settle(enq, need(context), [], { state: "in-terminal" }),
            "harness.turnStarted": ({ context, event }, enq) => {
              const started = harnessTurn(need(context), event);

              return started === null
                ? undefined
                : settle(enq, need(context), [started], { state: "working" });
            },
            "idle.timeout": ({ context, event }, enq) => {
              const stop = backgroundIdleStop(need(context), event);

              if (stop === null) return undefined;
              enq.emit({ type: "effect", effect: "stopHarness" });

              return settle(enq, need(context), stop.events, {
                state: "dormant",
                reason: stop.reason,
              });
            },
          },
        },
        working: {
          id: "working",
          on: {
            "turn.send": ({ context }, enq) => {
              const record = need(context);

              return workingTurn(record)?.trigger != null
                ? settle(enq, record, [])
                : reject(enq, turnRefusal(record, "send"));
            },
          },
        },
        "needs-you": {
          id: "needs-you",
          on: {
            // After a restart: an Interrupted Turn waits here for Continue (or a new Turn).
            "turn.send": sendTurn,
            "turn.continue": continueTurn,
            "turn.retry": retryTurn,
            "harness.approvalRequested": ({ context, event }, enq) =>
              approvalRequested(need(context), event, enq),
            "approval.respond": ({ context, event }, enq) => {
              const record = need(context);

              if (!record.pending.has(event.requestId)) return undefined;
              const refusal = decisionRefusal(record, event.requestId, event.decision);

              if (refusal !== null) return reject(enq, refusal);

              const resolved = DomainEvent.cases.ApprovalResolved.make({
                sessionId: record.session.id,
                requestId: event.requestId,
                decision: event.decision,
                resolvedBy: event.resolvedBy,
              });

              // The last answer puts the Harness back to work (if it has a Turn to work on).
              return settle(enq, record, [resolved], backToWork(record, event.requestId));
            },
            "harness.approvalWithdrawn": ({ context, event }, enq) => {
              const record = need(context);

              // The default handles it unless it removes the last request of a Turn in flight.
              if (backToWork(record, event.requestId) === undefined) return undefined;

              return settle(enq, record, [withdrawn(record, event)], { state: "working" });
            },
          },
        },
      },
    },
    /** The user took the session over in the Harness's own terminal UI. */
    "in-terminal": {
      id: "in-terminal",
      on: {
        "terminal.return": ({ context }, enq) =>
          settle(enq, need(context), [], { state: "starting" }),
        "model.set": (_, enq) => reject(enq, "the session is In Terminal; return it first"),
        "turns.accept": (_, enq) => reject(enq, "the session is In Terminal; return it first"),
        // Polaris follows along without changing the state.
        "harness.approvalRequested": ({ context, event }, enq) =>
          approvalRequested(need(context), event, enq),
        "harness.turnEnded": ({ context, event }, enq) =>
          turnEnded(need(context), event, enq, false),
        "harness.exited": ({ context, event }, enq) => exited(need(context), event, enq, false),
        "daemon.recover": ({ context, event }, enq) =>
          // An upgrade leaves a terminal UI alone; a restart recovers it like any live session.
          event.cause === "upgrade" ? HANDLED : recover(need(context), event, enq),
      },
    },
    /** No Harness process; resumes from the cursor on the next Turn. */
    dormant: {
      id: "dormant",
      on: {
        "turn.send": sendTurn,
        "turn.continue": continueTurn,
        "turn.retry": retryTurn,
        "terminal.open": ({ context }, enq) =>
          settle(enq, need(context), [], { state: "in-terminal" }),
        "harness.turnStarted": ({ context, event }, enq) => {
          const started = harnessTurn(need(context), event);

          return started === null
            ? undefined
            : settle(enq, need(context), [started], { state: "working" });
        },
        "harness.exited": ignore,
        "daemon.recover": ({ context, event }, enq) => recover(need(context), event, enq),
      },
    },
    failed: {
      id: "failed",
      on: {
        "turn.send": sendTurn,
        "turn.continue": continueTurn,
        "turn.retry": retryTurn,
        "terminal.open": ({ context }, enq) =>
          settle(enq, need(context), [], { state: "in-terminal" }),
      },
    },
    /** A usage limit stopped the last Turn; Continue (the user's, or at the reset) picks it up. */
    limited: {
      id: "limited",
      on: {
        "turn.send": sendTurn,
        "turn.continue": continueTurn,
        "terminal.open": ({ context }, enq) =>
          settle(enq, need(context), [], { state: "in-terminal" }),
        // A still-live Harness calling the model again means the limit has lifted.
        "harness.turnStarted": ({ context, event }, enq) => {
          const started = harnessTurn(need(context), event);

          return started === null
            ? undefined
            : settle(enq, need(context), [started], { state: "working" });
        },
        // The limit is still the fact; a Harness that goes away only ends its background work.
        "harness.exited": ({ context, event }, enq) => exited(need(context), event, enq, false),
      },
    },
    archived: {
      id: "archived",
      on: {
        "session.archive": (_, enq) => reject(enq, "the session is already Archived"),
        "session.unarchive": ({ context }, enq) =>
          settle(enq, need(context), [], { state: "dormant" }),
        "permissionMode.set": (_, enq) => reject(enq, "the session is Archived"),
        "model.set": (_, enq) => reject(enq, "the session is Archived"),
        "turns.accept": (_, enq) => reject(enq, "the session is Archived"),
        // Its Harness is being stopped: record a Turn's end, nothing else moves it.
        "harness.turnEnded": ({ context, event }, enq) =>
          turnEnded(need(context), event, enq, false),
        "harness.turnStarted": ignore,
        "harness.approvalRequested": ignore,
        "harness.exited": ignore,
        "session.fail": ignore,
        // Only Unarchive leaves Archived.
        "turn.interruptUnattended": ({ context, event }, enq) =>
          interruptUnattended(need(context), event.at, enq, false),
        // Nothing to recover, except in logs from before Archive refused a Turn in flight:
        // close what such a session left open, and keep it Archived.
        "daemon.recover": ({ context, event }, enq) => {
          const record = need(context);
          const turn = workingTurn(record);

          return settle(enq, record, [
            ...interruptedSetup(record, event.at, event.stoppedFor ?? event.cause),
            ...endBackgroundWork(record, event.at),
            ...(turn ? [endTurn(turn, "interrupted", event.at)] : []),
            ...withdrawPending(record, "daemon", RECOVERY_REASON[event.stoppedFor ?? event.cause]),
          ]);
        },
      },
    },
  },
});

// ── Running it ──────────────────────────────────────────────────────────────

export type SessionSnapshot = ReturnType<typeof sessionMachine.resolveState>;

const LIVE: ReadonlyArray<SessionState> = ["idle", "working", "needs-you"];

/** The Session State a snapshot stands for (`new` before the session exists). */
export const stateOf = (snapshot: SessionSnapshot): SessionState | "new" => {
  const value = snapshot.value;

  return Predicate.isString(value) ? value : value.live;
};

const snapshots = new WeakMap<SessionRecord, SessionSnapshot>();

const initial = sessionMachine.resolveState({ value: "new", context: { record: null } });

/** The machine snapshot the folded record stands for. */
export const snapshotOf = (record: SessionRecord | undefined): SessionSnapshot => {
  if (record === undefined) return initial;
  let snapshot = snapshots.get(record);

  if (snapshot === undefined) {
    const { state } = record.session;
    snapshot = sessionMachine.resolveState({
      value: LIVE.includes(state) ? { live: state } : state,
      context: { record },
    });
    snapshots.set(record, snapshot);
  }

  return snapshot;
};

export interface Decision {
  /** Domain events to persist, in order. */
  readonly events: ReadonlyArray<DomainEvent>;
  /** Why a command was refused; null when it was accepted (or for signals). */
  readonly rejection: string | null;
  /** What the engine runs after the events commit. */
  readonly effects: ReadonlyArray<SessionEffect>;
  /** The next snapshot: what the log will fold to once `events` commit. */
  readonly next: SessionSnapshot;
  /** No state handles the input: it changes nothing. */
  readonly unhandled: boolean;
}

/** One pure step of the lifecycle: `transition(snapshotOf(record), input)`. */
export const decideSession = (record: SessionRecord | undefined, input: SessionInput): Decision => {
  const snapshot = snapshotOf(record);

  if (
    record === undefined &&
    input.type !== "session.start" &&
    input.type !== "session.fork" &&
    input.type !== "turn.deliver"
  ) {
    return { events: [], rejection: null, effects: [], next: snapshot, unhandled: true };
  }

  const result = transition(
    sessionMachine,
    snapshot,
    normalizedInput(input, record?.session.updatedAt ?? "")
  );

  const events: Array<DomainEvent> = [];
  const effects: Array<SessionEffect> = [];
  let rejection: string | null = null;

  for (const action of result[1]) {
    if (action.kind !== "emit" || !isEmitted(action.event)) continue;
    const emitted = action.event;

    if (emitted.type === "domain") events.push(emitted.event);
    else if (emitted.type === "rejected") rejection = emitted.reason;
    else effects.push(emitted.effect);
  }

  return { events, rejection, effects, next: result[0], unhandled: isUnhandled(snapshot, result) };
};
