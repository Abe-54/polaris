/**
 * One Agent Session folded from `subscribeSession`: its Turns with their
 * completed items, the items still running (`ItemProgress`), and text still
 * streaming in. A Snapshot resets it, except the checkpoint commits seen so
 * far; Subagents' own items stay out, the Subagents themselves are kept.
 */
import {
  type AgentSession,
  type ApprovalDecision,
  ApprovalRequest,
  type DomainEvent,
  RequestId,
  type SessionStreamItem,
  type Subagent,
  type Turn,
  type TurnItem,
} from "@polaris/protocol";
import { Match, Predicate } from "effect";

export interface TurnEntry {
  readonly turn: Turn;
  /** Completed items, in completion order. */
  readonly items: ReadonlyArray<TurnItem>;
  /** Items still in progress, by id, replaced as their progress arrives. */
  readonly live: ReadonlyArray<TurnItem>;
  /** Text streaming into an item that hasn't completed, by item id. */
  readonly streaming: ReadonlyArray<{ readonly itemId: string; readonly text: string }>;
}

/** How a Secret Request this feed saw open ended; the value itself never reaches a Client. */
export interface SecretOutcome {
  readonly request: ApprovalRequest;
  readonly outcome: "saved" | "declined" | "ended";
}

/** The session as plain fields, so a change can copy it. */
export type Session = { readonly [K in keyof AgentSession]: AgentSession[K] };

export interface SessionFold {
  readonly sequence: number;
  readonly synchronized: boolean;
  readonly session: Session;
  /** Oldest first. */
  readonly turns: ReadonlyArray<TurnEntry>;
  readonly pendingApprovals: ReadonlyArray<ApprovalRequest>;
  /** Checkpoint refs to their commits, as `CheckpointRecorded` reported them on this feed. */
  readonly checkpoints: ReadonlyMap<string, string>;
  /** The Subagents of the Turns this feed holds, in the order they started. */
  readonly subagents: ReadonlyArray<Subagent>;
  /** Secret Requests that ended while this feed followed the session, oldest first. */
  readonly secretOutcomes: ReadonlyArray<SecretOutcome>;
}

type Fold = (state: SessionFold) => SessionFold;

const unchanged: Fold = (state) => state;

const patch =
  (fields: Partial<Session>): Fold =>
  (state) => ({ ...state, session: { ...state.session, ...fields } });

/** Only the changed Turn's entry is replaced, so the others keep their identity. */
const withTurn =
  (turnId: string, change: (entry: TurnEntry) => TurnEntry): Fold =>
  (state) => ({
    ...state,
    turns: state.turns.map((entry) => (entry.turn.id === turnId ? change(entry) : entry)),
  });

const withoutRequest =
  (requestId: string): Fold =>
  (state) => ({
    ...state,
    pendingApprovals: state.pendingApprovals.filter((request) => request.id !== requestId),
  });

const secretOutcomeOf = (decision: ApprovalDecision | null): SecretOutcome["outcome"] =>
  decision === null
    ? "ended"
    : Match.value(decision).pipe(
        Match.tag("Provided", () => "saved" as const),
        Match.tag("Deny", () => "declined" as const),
        Match.orElse(() => "ended" as const)
      );

/** The request leaves; a secret's outcome is kept to show how it ended. */
const settle =
  (requestId: string, decision: ApprovalDecision | null): Fold =>
  (state) => {
    const secret = state.pendingApprovals.find(
      (request) => request.id === requestId && request.kind === "secret"
    );

    const next = withoutRequest(requestId)(state);

    return secret === undefined
      ? next
      : {
          ...next,
          secretOutcomes: [
            ...state.secretOutcomes,
            { request: secret, outcome: secretOutcomeOf(decision) },
          ],
        };
  };

/** A Subagent's latest state, kept in the place it started. */
const withSubagent =
  (subagent: Subagent): Fold =>
  (state) => ({
    ...state,
    subagents: state.subagents.some((held) => held.id === subagent.id)
      ? state.subagents.map((held) => (held.id === subagent.id ? subagent : held))
      : [...state.subagents, subagent],
  });

const entryOf = (turn: Turn, items: ReadonlyArray<TurnItem> = []): TurnEntry => ({
  turn,
  items,
  live: [],
  streaming: [],
});

const startTurn =
  (turn: Turn): Fold =>
  (state) => ({
    ...state,
    session: { ...state.session, turnCount: Math.max(state.session.turnCount, turn.index + 1) },
    turns: [...state.turns.filter((entry) => entry.turn.id !== turn.id), entryOf(turn)],
  });

const completeItem = (turnId: string, item: TurnItem): Fold =>
  withTurn(turnId, (entry) => ({
    ...entry,
    items: [...entry.items.filter((done) => done.id !== item.id), item],
    live: entry.live.filter((running) => running.id !== item.id),
    streaming: entry.streaming.filter((text) => text.itemId !== item.id),
  }));

const endTurn = (turn: Turn): Fold =>
  withTurn(turn.id, (entry) => ({ ...entry, turn, live: [], streaming: [] }));

const foldEvent = (event: DomainEvent): Fold =>
  Match.value(event).pipe(
    Match.tags({
      SessionStateChanged: (changed) =>
        patch({
          state: changed.state,
          lastError: changed.state === "failed" ? changed.reason : null,
        }),
      SessionRenamed: ({ title }) => patch({ title }),
      SessionModelChanged: ({ model, effort }) => patch({ model, effort }),
      SessionPermissionModeChanged: ({ permissionMode }) => patch({ permissionMode }),
      TurnStarted: ({ turn }) => startTurn(turn),
      TurnItemCompleted: ({ turnId, item, subagentId }) =>
        subagentId === null ? completeItem(turnId, item) : unchanged,
      TurnEnded: ({ turn }) => endTurn(turn),
      ApprovalRequested:
        ({ request }): Fold =>
        (state) => ({
          ...state,
          pendingApprovals: [...withoutRequest(request.id)(state).pendingApprovals, request],
        }),
      CheckpointRecorded:
        ({ ref, commit }): Fold =>
        (state) => ({ ...state, checkpoints: new Map(state.checkpoints).set(ref, commit) }),
      SubagentStarted: ({ subagent }) => withSubagent(subagent),
      SubagentEnded: ({ subagent }) => withSubagent(subagent),
      ApprovalResolved: ({ requestId, decision }) => settle(requestId, decision),
      ApprovalWithdrawn: ({ requestId }) => settle(requestId, null),
    }),
    Match.orElse(() => unchanged)
  );

const appendText = (turnId: string, itemId: string, text: string): Fold =>
  withTurn(turnId, (entry) => {
    const held = entry.streaming.find((live) => live.itemId === itemId);

    return {
      ...entry,
      streaming:
        held === undefined
          ? [...entry.streaming, { itemId, text }]
          : entry.streaming.map((live) =>
              live === held ? { itemId, text: live.text + text } : live
            ),
    };
  });

const progress = (turnId: string, item: TurnItem): Fold =>
  withTurn(turnId, (entry) =>
    entry.items.some((done) => done.id === item.id)
      ? entry
      : { ...entry, live: [...entry.live.filter((running) => running.id !== item.id), item] }
  );

/** Applies one item of a session's feed; null before the first Snapshot. */
export const applySessionItem = (
  state: SessionFold | null,
  item: SessionStreamItem
): SessionFold | null =>
  Match.value(item).pipe(
    Match.tagsExhaustive({
      Snapshot: (snapshot): SessionFold => ({
        sequence: snapshot.sequence,
        synchronized: false,
        session: snapshot.session,
        turns: snapshot.turns.map((detail) => entryOf(detail.turn, detail.items)),
        pendingApprovals: snapshot.pendingApprovals,
        checkpoints: state?.checkpoints ?? new Map(),
        subagents: snapshot.turns.flatMap((detail) =>
          detail.subagents.map((held) => held.subagent)
        ),
        secretOutcomes: state?.secretOutcomes ?? [],
      }),
      Event: ({ envelope }) => {
        if (state === null || envelope.sequence <= state.sequence) return state;
        // A session's feed carries only that session's events.
        const next = foldEvent(envelope.event)(state);

        return { ...next, sequence: envelope.sequence };
      },
      Delta: ({ turnId, itemId, field, text, subagentId }) =>
        state === null || subagentId !== null || field !== "text"
          ? state
          : appendText(turnId, itemId, text)(state),
      ItemProgress: ({ turnId, item, subagentId }) =>
        state === null || subagentId !== null ? state : progress(turnId, item)(state),
      Synchronized: ({ sequence }) =>
        state === null ? null : { ...state, sequence, synchronized: true },
    })
  );

/** Older Turns paged in, ahead of those the feed holds; ones it already has are skipped. */
export const withOlder = (
  state: SessionFold,
  older: ReadonlyArray<{ readonly turn: Turn; readonly items: ReadonlyArray<TurnItem> }>
): SessionFold => {
  const first = state.turns[0]?.turn.index ?? Number.POSITIVE_INFINITY;
  const before = older.filter((detail) => detail.turn.index < first);

  return before.length === 0
    ? state
    : { ...state, turns: [...before.map((d) => entryOf(d.turn, d.items)), ...state.turns] };
};

/**
 * The commit a session Risk Summary of every ended Turn is keyed by: the last ended Turn's
 * after-checkpoint, as the Turn carries it, or as this feed saw it recorded (older Daemons).
 */
export const summaryHead = (state: SessionFold): string | null => {
  const ended = state.turns.findLast((entry) => entry.turn.status !== "working");
  const ref = ended?.turn.checkpointAfter ?? null;

  if (ref === null) return null;

  return ended?.turn.checkpointAfterCommit ?? state.checkpoints.get(ref) ?? null;
};

const REQUEST_SECRET = /^(?:mcp__polaris(?:_\d+)?__|polaris(?:_\d+)?\.)request_secret$/;

/** How Polaris's reply to `request_secret` begins for each ending (`mcp/tools/secret.ts`). */
const SECRET_REPLIES: ReadonlyArray<readonly [prefix: string, SecretOutcome["outcome"]]> = [
  ["Saved.", "saved"],
  ["The user declined", "declined"],
  ["No answer in", "ended"],
  ["The request ended unanswered", "ended"],
];

type ToolOutput = Extract<TurnItem, { readonly _tag: "ToolCall" }>["output"];

/** The first text in a tool's output, as Harnesses wrap MCP text blocks. */
const textIn = (output: ToolOutput, depth = 0): string | null => {
  if (depth > 4 || output === null || output === undefined) return null;

  if (Predicate.isString(output)) return output;

  const parts = Array.isArray(output)
    ? output
    : ["text", "content", "result"].flatMap((key) =>
        Predicate.hasProperty(output, key) ? [output[key]] : []
      );

  for (const part of parts) {
    const text = textIn(part, depth + 1);

    if (text !== null) return text;
  }

  return null;
};

/** A finished `request_secret` call as the strip shows it, from Polaris's reply (ENG-631). */
const toolSecretOutcome = (turn: Turn, item: TurnItem): SecretOutcome | null => {
  if (!Predicate.isTagged(item, "ToolCall") || !REQUEST_SECRET.test(item.name)) return null;
  const reply = (textIn(item.output) ?? "").trimStart();
  const outcome = SECRET_REPLIES.find(([prefix]) => reply.startsWith(prefix))?.[1];
  const label = Predicate.hasProperty(item.input, "label") ? item.input.label : null;

  if (outcome === undefined || !Predicate.isString(label) || label === "") return null;

  const request = new ApprovalRequest({
    id: RequestId.make(`tool:${item.id}`),
    sessionId: turn.sessionId,
    turnId: turn.id,
    kind: "secret",
    title: label,
    detail: null,
    options: [],
    questions: [],
    openedAt: item.startedAt ?? turn.startedAt,
  });

  return { request, outcome };
};

/**
 * The last Secret Request that ended in the session's latest Turn: the strip says how. One this
 * feed didn't see end (a reload) comes from its `request_secret` call's reply.
 */
export const latestSecretOutcome = (state: SessionFold): SecretOutcome | null => {
  const latest = state.turns.at(-1);
  const outcome = state.secretOutcomes.at(-1);

  if (latest === undefined) return null;

  if (outcome !== undefined && outcome.request.turnId === latest.turn.id) return outcome;

  for (let at = latest.items.length - 1; at >= 0; at--) {
    const item = latest.items[at];
    const ended = item === undefined ? null : toolSecretOutcome(latest.turn, item);

    if (ended !== null) return ended;
  }

  return null;
};
