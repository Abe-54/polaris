/**
 * The Engine model-based test's reference side (`engine.model.slow.test.ts`): the
 * committed log abstracted to comparable events, a fold of it into per-session
 * views, and a reference decider for the Client commands the test sends.
 */
import { Command, DomainEvent, type EventEnvelope, type RequestId } from "@polaris/protocol";
import { sessionOf } from "../store/model.ts";

export const SESSIONS = ["s1", "s2"] as const;

export type SessionName = (typeof SESSIONS)[number];

export const CLIENTS = ["mac", "phone"] as const;

export type ClientName = (typeof CLIENTS)[number];

export type StreamName = "host" | SessionName;

export const STREAMS: ReadonlyArray<StreamName> = ["host", ...SESSIONS];

// ── The log, abstracted ─────────────────────────────────────────────────────

export interface AEvent {
  readonly seq: number;
  readonly commandId: string | null;
  readonly session: string | null;
  readonly tag: EventEnvelope["event"]["_tag"];
  /** A short, comparable description of what the event says. */
  readonly what: string;
  readonly turnId?: string;
  readonly autonomous?: boolean;
  readonly inputRefused?: boolean;
  readonly status?: string;
  readonly state?: string;
  readonly requestId?: string;
  readonly reason?: string | null;
  readonly index?: number;
}

type TurnEvent =
  | typeof DomainEvent.cases.TurnStarted.Type
  | typeof DomainEvent.cases.TurnEnded.Type;

const turnFields = (e: TurnEvent) => ({
  what: `${e._tag}:${e.turn.status}`,
  turnId: e.turn.id,
  status: e.turn.status,
});

export const abstractEvent = (envelope: EventEnvelope): AEvent => {
  const e = envelope.event;
  const seq: number = envelope.sequence;
  const commandId: string | null = envelope.commandId;
  const base = { seq, commandId, session: sessionOf(e), tag: e._tag };

  return DomainEvent.matchOrElse<AEvent>(
    e,
    {
      SessionCreated: (c) => ({ ...base, what: c._tag, state: c.session.state }),
      SessionStateChanged: (c) => ({
        ...base,
        what: `state:${c.state}`,
        state: c.state,
        reason: c.reason,
      }),
      TurnStarted: (c) => ({ ...base, ...turnFields(c), autonomous: c.turn.trigger != null }),
      TurnEnded: (c) => ({ ...base, ...turnFields(c) }),
      TurnItemCompleted: (c) => ({
        ...base,
        what: c._tag,
        inputRefused: c.item.id.startsWith("refused:") || c.item.id.startsWith("refusal:"),
      }),
      ApprovalRequested: (c) => ({
        ...base,
        what: `requested:${c.request.id}`,
        requestId: c.request.id,
        turnId: c.request.turnId,
      }),
      ApprovalResolved: (c) => ({
        ...base,
        what: `resolved:${c.requestId}:${c.resolvedBy}`,
        requestId: c.requestId,
      }),
      ApprovalWithdrawn: (c) => ({
        ...base,
        what: `withdrawn:${c.requestId}:${c.withdrawnBy}`,
        requestId: c.requestId,
        reason: c.reason,
      }),
      TurnsAccepted: (c) => ({
        ...base,
        what: `accepted:${c.throughIndex}`,
        index: c.throughIndex,
      }),
    },
    () => ({ ...base, what: e._tag })
  );
};

export const inStream = (e: AEvent, stream: StreamName) =>
  stream === "host"
    ? e.tag !== "TurnItemCompleted" &&
      e.tag !== "CheckpointRecorded" &&
      e.tag !== "SessionContextUsed"
    : e.session === stream;

export const streamSeqs = (log: ReadonlyArray<AEvent>, stream: StreamName) =>
  log.flatMap((e) => (inStream(e, stream) ? [e.seq] : []));

// ── Reference model: a fold of the log, and a decider for Client commands ───

export interface View {
  state: string;
  autonomous: boolean;
  readonly turns: Map<string, string>;
  readonly order: Array<string>;
  readonly pending: Set<string>;
  /** The index of the last accepted Turn (its position in `order`). */
  accepted: number | null;
}

const applyToView = (v: View, e: AEvent) => {
  switch (e.tag) {
    case "SessionStateChanged":
      v.state = e.state!;
      break;
    case "TurnStarted":
      v.autonomous = e.autonomous === true;
    case "TurnEnded":
      if (!v.turns.has(e.turnId!)) v.order.push(e.turnId!);
      v.turns.set(e.turnId!, e.status!);
      break;
    case "ApprovalRequested":
      v.pending.add(e.requestId!);
      break;
    case "ApprovalResolved":
    case "ApprovalWithdrawn":
      v.pending.delete(e.requestId!);
      break;
    case "TurnsAccepted":
      v.accepted = e.index!;
      break;
  }
};

export const fold = (log: ReadonlyArray<AEvent>, upTo = log.length): Map<string, View> => {
  const views = new Map<string, View>();

  for (const e of log.slice(0, upTo)) {
    if (e.session === null) continue;

    if (e.tag === "SessionCreated") {
      views.set(e.session, {
        state: e.state!,
        autonomous: false,
        turns: new Map(),
        order: [],
        pending: new Set(),
        accepted: null,
      });
      continue;
    }

    const v = views.get(e.session);

    if (v !== undefined) applyToView(v, e);
  }

  return views;
};

export const workingTurnOf = (v: View) => v.order.find((id) => v.turns.get(id) === "working");

/** What a command records according to the reference decider, or "reject". */
export type Reference = ReadonlyArray<string> | "reject";

const acceptsTurn = (v: View) =>
  workingTurnOf(v) === undefined &&
  (["idle", "dormant", "failed", "limited"].includes(v.state) ||
    (v.state === "needs-you" && v.pending.size === 0));

const turnStart = (v: View): Reference => [
  "TurnStarted:working",
  v.state === "idle" ? "state:working" : "state:starting",
];

/** Continue resumes an Interrupted last Turn; Retry sends a Failed one again. */
const decideAfter = (v: View, status: "interrupted" | "failed"): Reference => {
  const last = v.order.at(-1);

  // An accepted Interrupted Turn is never continued (spec finding 4); Retry starts a new Turn.
  const accepted =
    status === "interrupted" && v.accepted !== null && v.order.length - 1 <= v.accepted;

  return last !== undefined && v.turns.get(last) === status && acceptsTurn(v) && !accepted
    ? turnStart(v)
    : "reject";
};

/** A contiguous prefix, between Turns, never backwards; the same Turn again records nothing. */
const decideAccept = (v: View, turnId: string): Reference => {
  const index = v.order.indexOf(turnId);

  if (index === -1 || ["archived", "in-terminal"].includes(v.state)) return "reject";

  if (workingTurnOf(v) !== undefined) return "reject";

  if (v.accepted !== null && index < v.accepted) return "reject";

  return index === v.accepted ? [] : [`accepted:${index}`];
};

const decideRespond = (v: View, requestId: RequestId, device: string): Reference => {
  if (!v.pending.has(requestId)) return "reject";

  const resumes = v.pending.size === 1 && v.state === "needs-you" && workingTurnOf(v) !== undefined;

  return [`resolved:${requestId}:${device}`, ...(resumes ? ["state:working"] : [])];
};

const decideArchive = (v: View): Reference => {
  // Refused while a Turn is in flight, in every state (ENG-209 finding 2).
  if (v.state === "archived" || workingTurnOf(v) !== undefined) return "reject";

  return [...[...v.pending].map((r) => `withdrawn:${r}:daemon`), "state:archived"];
};

export const referenceDecide = (v: View, command: Command, device: string): Reference =>
  Command.matchOrElse<Reference>(
    command,
    {
      SendTurn: () =>
        v.state === "working" && v.autonomous ? [] : acceptsTurn(v) ? turnStart(v) : "reject",
      Continue: () => decideAfter(v, "interrupted"),
      Retry: () => decideAfter(v, "failed"),
      RespondToApproval: (c) => decideRespond(v, c.requestId, device),
      Interrupt: () => (workingTurnOf(v) === undefined ? "reject" : []),
      ArchiveSession: () => decideArchive(v),
      UnarchiveSession: () => (v.state === "archived" ? ["state:dormant"] : "reject"),
      AcceptTurns: (c) => decideAccept(v, c.throughTurnId),
      RenameSession: () => ["SessionRenamed"],
      // Between Turns only; each generated Model is new, so it always records a change.
      SetModel: () =>
        v.state === "archived" || v.state === "in-terminal" || workingTurnOf(v) !== undefined
          ? "reject"
          : ["SessionModelChanged"],
    },
    (c) => {
      throw new Error(`no reference for ${c._tag}`);
    }
  );

export const sessionOfCommand = (command: Command): string =>
  "sessionId" in command ? command.sessionId : "";
