/**
 * The thread as flat rows for a virtualized list (MX-E): every Turn in order, its prompt,
 * replies and numbered tool steps; finished calls in a row fold into a run until opened
 * (`steps.ts`), and a finished Turn ends on its receipt. A Turn's rows are cached on its
 * entry, so text streaming into the latest Turn rebuilds only that Turn's rows.
 */
import type { Attachment, SessionState, TurnId, TurnItem } from "@polaris/protocol";
import type { FollowUp } from "./composer.ts";
import { Match, Predicate } from "effect";
import type { Session, TurnEntry } from "./fold.ts";
import { compactionLine } from "./idleCompaction.ts";
import { elapsed } from "./labels.ts";
import type { OutgoingSteer } from "./outbox.ts";
import type { OutgoingSend } from "./sends.ts";
import { runKind, runSummary, toolLabel } from "./steps.ts";
import { type Visualization, visualizationOf } from "../visualization/model.ts";

/** What a finished Turn's long-press menu needs (MX-J). */
export interface TurnFacts {
  readonly turnId: TurnId;
  /** One-based, as the UI numbers Turns. */
  readonly number: number;
  /** When the Turn started (ISO). */
  readonly startedAt: string;
  /** "4 files · 2 commands · 1m 41s"; empty when there is nothing to say. */
  readonly receipt: string;
  /** Every reply as Markdown, a blank line apart: what Copy puts on the pasteboard. */
  readonly output: string;
}

export type StepTone = "done" | "active" | "failed";

/** What a sent Turn waits on: the Host to be back, or the user, after it failed. */
export type SendWaiting =
  | { readonly kind: "queued" }
  | { readonly kind: "failed"; readonly error: string };

interface RowBase {
  readonly key: string;
  readonly turnId: string;
}

export type ThreadRow = RowBase &
  (
    | {
        readonly kind: "prompt";
        readonly text: string;
        readonly attachments: ReadonlyArray<Attachment>;
      }
    /** A Turn the user didn't send, as one quiet line after the Turn before it: idle compaction. */
    | { readonly kind: "quiet"; readonly text: string }
    /** A steer the Harness took, where it landed in the Turn. */
    | { readonly kind: "steered"; readonly text: string }
    /** A steer or queued follow-up still on its way, or why a steer didn't land. */
    | {
        readonly kind: "outgoing";
        readonly id: string;
        readonly text: string;
        readonly attachments: ReadonlyArray<Attachment>;
        readonly failed: boolean;
        readonly note: string;
      }
    /** A Turn sent from the composer that the thread doesn't show yet (MX-AV). */
    | {
        readonly kind: "send";
        readonly id: string;
        readonly text: string;
        readonly attachments: ReadonlyArray<Attachment>;
        /** Queued while the Host is away; failed, with why. */
        readonly waiting: SendWaiting | null;
      }
    | {
        readonly kind: "reply";
        readonly text: string;
        /** Its finished Turn, for the long-press menu; null while the Turn works. */
        readonly turn: TurnFacts | null;
        /** The receipt line under it: only on a finished Turn's last reply, its summary. */
        readonly receipt: string | null;
      }
    /** A finished Turn's receipt where it has no reply to sit under. */
    | { readonly kind: "receipt"; readonly text: string; readonly turn: TurnFacts }
    | {
        readonly kind: "step";
        /** Two digits, counted within its Turn: "01". */
        readonly index: string;
        readonly label: string;
        readonly detail: string;
        readonly tone: StepTone;
        /** Files it touched, to mark the one a Critical finding is in. */
        readonly paths: ReadonlyArray<string>;
        /** The first and last rows of a group of steps open and close its well. */
        readonly first: boolean;
        readonly last: boolean;
      }
    | {
        readonly kind: "run";
        /** "Read 3 files, ran 4 commands", as the Desktop App says it. */
        readonly summary: string;
        readonly open: boolean;
        /** As a step's: the first and last of a group open and close its well. */
        readonly first: boolean;
        readonly last: boolean;
      }
    | { readonly kind: "error"; readonly text: string }
    /** A `visualize` call: its own card, never folded into a run (DESIGN.md, Visualizations). */
    | { readonly kind: "visualization"; readonly visualization: Visualization }
  );

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const firstLine = (text: string) => {
  const trimmed = text.trim();
  const end = trimmed.indexOf("\n");

  return end === -1 ? trimmed : trimmed.slice(0, end);
};

const toneOf = (status: "running" | "completed" | "failed" | "declined"): StepTone =>
  Match.value(status).pipe(
    Match.when("running", (): StepTone => "active"),
    Match.when("completed", (): StepTone => "done"),
    Match.orElse((): StepTone => "failed")
  );

const VERBS = { add: "Created", modify: "Edited", delete: "Deleted" } as const;

type Step = Omit<
  Extract<ThreadRow, { kind: "step" }>,
  "key" | "turnId" | "index" | "first" | "last"
>;

const fileStep = (item: Extract<TurnItem, { _tag: "FileChange" }>): Step => {
  const paths = item.changes.map((change) => change.path);
  const only = item.changes.length === 1 ? item.changes[0] : undefined;
  const running = item.status === "running";

  const label =
    only === undefined
      ? `${running ? "Editing" : "Edited"} ${item.changes.length} files`
      : `${running ? "Writing" : VERBS[only.kind]} ${basename(only.path)}`;

  return {
    kind: "step",
    label,
    detail: failedDetail(item.status),
    tone: toneOf(item.status),
    paths,
  };
};

const failedDetail = (status: "running" | "completed" | "failed" | "declined") =>
  Match.value(status).pipe(
    Match.when("declined", () => "declined"),
    Match.when("failed", () => "failed"),
    Match.orElse(() => "")
  );

const commandStep = (item: Extract<TurnItem, { _tag: "CommandExecution" }>): Step => ({
  kind: "step",
  label: firstLine(item.command),
  detail:
    item.status === "failed" && item.exitCode !== null
      ? `exit ${item.exitCode}`
      : failedDetail(item.status),
  tone: toneOf(item.status),
  paths: [],
});

const toolStep = (item: Extract<TurnItem, { _tag: "ToolCall" }>): Step => ({
  kind: "step",
  label: toolLabel(item),
  detail: failedDetail(item.status),
  tone: toneOf(item.status),
  paths: [],
});

const planStep = (item: Extract<TurnItem, { _tag: "Plan" }>): Step => {
  const done = item.steps.filter((step) => step.status === "completed").length;

  return {
    kind: "step",
    label: "Updated the plan",
    detail: item.steps.length === 0 ? "" : `${done} of ${item.steps.length}`,
    tone: done === item.steps.length ? "done" : "active",
    paths: [],
  };
};

type Piece =
  | {
      readonly kind: "text";
      readonly row: "reply" | "steered" | "error";
      readonly text: string;
    }
  | Step
  | { readonly kind: "visualization"; readonly visualization: Visualization }
  | null;

const pieceOf = (item: TurnItem): Piece =>
  Match.value(item).pipe(
    Match.tagsExhaustive({
      AssistantMessage: ({ text }): Piece => ({ kind: "text", row: "reply", text }),
      UserMessage: ({ text }): Piece => ({ kind: "text", row: "steered", text }),
      Error: ({ message }): Piece => ({ kind: "text", row: "error", text: message }),
      // Thinking stays out of the phone's thread.
      Reasoning: (): Piece => null,
      CommandExecution: commandStep,
      FileChange: fileStep,
      ToolCall: (call): Piece => {
        const visualization = visualizationOf(call);

        return visualization === null ? toolStep(call) : { kind: "visualization", visualization };
      },
      Plan: planStep,
    })
  );

/** Thousands grouped as the rest of the copy is written: "1,284 files". */
const GROUPED = new Intl.NumberFormat("en-US");

const pad = (n: number) => n.toString().padStart(2, "0");

interface Placed {
  readonly id: string;
  readonly item: TurnItem | null;
  readonly piece: Exclude<Piece, null>;
}

/** An ended Turn has nothing in flight: its unfinished plan reads as done, a running call stopped. */
const settled = (piece: Piece, item: TurnItem): Piece => {
  // A Visualization still drawing when its Turn ended never arrived: no card.
  if (piece?.kind === "visualization") return piece.visualization.drawing ? null : piece;

  if (piece === null || piece.kind !== "step" || piece.tone !== "active") return piece;

  return Predicate.isTagged(item, "Plan")
    ? { ...piece, tone: "done" }
    : { ...piece, tone: "failed", detail: "stopped" };
};

/** Its items in order, then what is still live, then text streaming into no item yet. */
const placedOf = (entry: TurnEntry): ReadonlyArray<Placed> => {
  const live = new Set(entry.live.map((item) => item.id));
  const items = [...entry.items, ...entry.live];

  const streamingOnly = entry.streaming
    .filter((text) => !items.some((item) => item.id === text.itemId))
    .map((text) => ({
      id: text.itemId,
      item: null,
      piece: { kind: "text", row: "reply", text: text.text } as const,
    }));

  const ended = entry.turn.status !== "working";

  return [
    ...items.flatMap((item) => {
      const piece = ended ? settled(pieceOf(item), item) : pieceOf(item);

      // A live item is still running whatever its status says: never folded.
      return piece === null ? [] : [{ id: item.id, item: live.has(item.id) ? null : item, piece }];
    }),
    ...streamingOnly,
  ];
};

/** Consecutive finished calls as runs; a lone call stays a step. */
const segments = (placed: ReadonlyArray<Placed>) => {
  const out: Array<{ readonly run: ReadonlyArray<Placed> } | { readonly one: Placed }> = [];
  let pending: Array<Placed> = [];

  const flush = () => {
    if (pending.length > 1) out.push({ run: pending });
    else pending.forEach((one) => out.push({ one }));
    pending = [];
  };

  for (const one of placed) {
    if (one.item !== null && runKind(one.item) !== null) pending.push(one);
    else {
      flush();
      out.push({ one });
    }
  }

  flush();

  return out;
};

/** The rows of one opened Turn: its prompt, then its items, each run folded unless `isOpen`. */
const openRows = (
  entry: TurnEntry,
  isOpen: (runKey: string) => boolean
): ReadonlyArray<ThreadRow> => {
  const { turn } = entry;
  const rows: Array<ThreadRow> = [];
  let step = 0;
  const quiet = compactionLine(turn);

  if (quiet !== null)
    rows.push({ kind: "quiet", key: `${turn.id}:q`, turnId: turn.id, text: quiet });
  else if (turn.prompt.trim() !== "" || turn.attachments.length > 0)
    rows.push({
      kind: "prompt",
      key: `${turn.id}:p`,
      turnId: turn.id,
      text: turn.prompt,
      attachments: turn.attachments,
    });

  const streamed = new Map(entry.streaming.map((live) => [live.itemId, live.text]));

  const place = ({ id, piece }: Placed, shown: boolean) => {
    if (piece.kind === "visualization") {
      rows.push({ ...piece, key: `${turn.id}:${id}`, turnId: turn.id });

      return;
    }

    if (piece.kind === "step") {
      step++;

      if (shown)
        rows.push({
          ...piece,
          key: `${turn.id}:${id}`,
          turnId: turn.id,
          index: pad(step),
          first: false,
          last: false,
        });

      return;
    }

    const text = streamed.get(id) ?? piece.text;

    if (text.trim() === "") return;
    const key = `${turn.id}:${id}`;

    rows.push(
      piece.row === "reply"
        ? { kind: "reply", key, turnId: turn.id, text, turn: null, receipt: null }
        : { kind: piece.row, key, turnId: turn.id, text }
    );
  };

  for (const segment of segments(placedOf(entry))) {
    if ("one" in segment) {
      place(segment.one, true);
      continue;
    }

    const key = `${turn.id}:run:${segment.run[0]?.id ?? ""}`;
    const open = isOpen(key);
    const summary = runSummary(segment.run.flatMap(({ item }) => (item === null ? [] : [item])));
    rows.push({ kind: "run", key, turnId: turn.id, summary, open, first: false, last: false });
    segment.run.forEach((one) => place(one, open));
  }

  // Idle compaction belongs to the Turn before it: no receipt or Turn menu of its own.
  return quiet === null ? withReceipt(entry, grouped(rows)) : grouped(rows);
};

const isGrouped = (row: ThreadRow | undefined) => row?.kind === "step" || row?.kind === "run";

/** Marks where each group of steps opens and closes its well. */
const grouped = (rows: ReadonlyArray<ThreadRow>): Array<ThreadRow> =>
  rows.map((row, index) =>
    row.kind === "step" || row.kind === "run"
      ? { ...row, first: !isGrouped(rows[index - 1]), last: !isGrouped(rows[index + 1]) }
      : row
  );

const plural = (count: number, one: string) =>
  `${GROUPED.format(count)} ${count === 1 ? one : `${one}s`}`;

/** How a Turn that didn't complete ended, first on its receipt. */
const ENDINGS: Readonly<Record<TurnEntry["turn"]["status"], string | null>> = {
  working: null,
  completed: null,
  interrupted: "Stopped",
  failed: "Failed",
};

/** A finished Turn's receipt as the Desktop App words it, leaving out what it didn't do. */
export const turnReceipt = (entry: TurnEntry): string => {
  const { turn, items } = entry;

  const files = new Set(
    items.flatMap((item) =>
      Predicate.isTagged(item, "FileChange") ? item.changes.map((change) => change.path) : []
    )
  ).size;

  const commands = items.filter((item) => Predicate.isTagged(item, "CommandExecution")).length;

  const took =
    turn.endedAt === null ? Number.NaN : Date.parse(turn.endedAt) - Date.parse(turn.startedAt);

  return [
    ENDINGS[turn.status],
    files === 0 ? null : plural(files, "file"),
    commands === 0 ? null : plural(commands, "command"),
    Number.isNaN(took) ? null : elapsed(took),
  ]
    .filter((part) => part !== null)
    .join(" · ");
};

const factsOf = (entry: TurnEntry, rows: ReadonlyArray<ThreadRow>): TurnFacts => ({
  turnId: entry.turn.id,
  number: entry.turn.userTurnNumber ?? entry.turn.index + 1,
  startedAt: entry.turn.startedAt,
  receipt: turnReceipt(entry),
  output: rows.flatMap((row) => (row.kind === "reply" ? [row.text.trim()] : [])).join("\n\n"),
});

/** A finished Turn: its replies carry its facts, and the last one its receipt. */
const withReceipt = (entry: TurnEntry, rows: Array<ThreadRow>): ReadonlyArray<ThreadRow> => {
  if (entry.turn.status === "working") return rows;

  // A completed Turn that showed nothing has nothing to report or offer: no lone "0s" (ENG-551).
  if (rows.length === 0 && ENDINGS[entry.turn.status] === null) return rows;
  const turn = factsOf(entry, rows);
  // The receipt ends the Turn: under its last reply only when nothing follows that reply.
  const summary = rows.at(-1)?.kind === "reply" ? rows.length - 1 : -1;

  const out = rows.map((row, index) =>
    row.kind === "reply"
      ? { ...row, turn, receipt: index === summary && turn.receipt !== "" ? turn.receipt : null }
      : row
  );

  if (summary !== -1 || turn.receipt === "") return out;

  return [
    ...out,
    {
      kind: "receipt",
      key: `${entry.turn.id}:receipt`,
      turnId: entry.turn.id,
      text: turn.receipt,
      turn,
    },
  ];
};

export type StepRow = Extract<ThreadRow, { kind: "step" }>;

/** Every step of a Turn, folded or not, numbered as the thread numbers them. */
export const turnSteps = (entry: TurnEntry): ReadonlyArray<StepRow> =>
  openRows(entry, () => true).filter((row): row is StepRow => row.kind === "step");

const opened = new WeakMap<
  TurnEntry,
  { readonly runs: string; readonly rows: ReadonlyArray<ThreadRow> }
>();

/** Which of the Turn's runs are open, as a cache key. */
const openRuns = (entry: TurnEntry, expanded: ReadonlySet<string>) => {
  const prefix = `${entry.turn.id}:run:`;

  return [...expanded].filter((key) => key.startsWith(prefix)).join("\n");
};

const cachedOpen = (entry: TurnEntry, expanded: ReadonlySet<string>) => {
  const runs = openRuns(entry, expanded);
  const held = opened.get(entry);

  if (held !== undefined && held.runs === runs) return held.rows;
  const rows = openRows(entry, (key) => expanded.has(key));
  opened.set(entry, { runs, rows });

  return rows;
};

/** Oldest first, every Turn open; a run opens when its row's key is in `expanded`. */
export const threadRows = (
  turns: ReadonlyArray<TurnEntry>,
  expanded: ReadonlySet<string>
): ReadonlyArray<ThreadRow> => turns.flatMap((entry) => cachedOpen(entry, expanded));

/** Steers, then queued follow-ups, still on their way, oldest first, for the thread's foot. */
const waitingOf = (entry: OutgoingSend) =>
  Match.value(entry.status).pipe(
    Match.when("queued", (): SendWaiting => ({ kind: "queued" })),
    Match.when("failed", (): SendWaiting => ({
      kind: "failed",
      error: entry.error ?? "Didn't send",
    })),
    Match.orElse((): SendWaiting | null => null)
  );

export const outgoingRows = (
  steers: ReadonlyArray<OutgoingSteer>,
  queued: ReadonlyArray<FollowUp> = [],
  sends: ReadonlyArray<OutgoingSend> = []
): ReadonlyArray<ThreadRow> => [
  ...steers.map((entry): ThreadRow => ({
    kind: "outgoing",
    key: `out:${entry.id}`,
    turnId: entry.turnId,
    id: entry.id,
    text: entry.text,
    attachments: [],
    failed: entry.status === "failed",
    note: entry.status === "failed" ? `${entry.error ?? "Didn't send"} · Tap to edit` : "Steering…",
  })),
  ...sends.map((entry): ThreadRow => ({
    kind: "send",
    key: `send:${entry.id}`,
    turnId: "",
    id: entry.id,
    text: entry.text,
    attachments: entry.attachments,
    waiting: waitingOf(entry),
  })),
  ...queued.map((entry, index): ThreadRow => ({
    kind: "outgoing",
    key: `queued:${index}`,
    turnId: "",
    id: `queued:${index}`,
    text: entry.text,
    attachments: entry.attachments,
    failed: false,
    note: "Queued for after this turn",
  })),
];

/** The newest ended Turn among those whose rows are on screen, for the read position. */
export const newestEndedOnScreen = (
  turns: ReadonlyArray<TurnEntry>,
  visibleTurnIds: ReadonlyArray<string>
): TurnEntry | null => {
  const ids = new Set(visibleTurnIds);
  let newest: TurnEntry | null = null;

  for (const entry of turns) {
    if (entry.turn.status !== "working" && ids.has(entry.turn.id)) newest = entry;
  }

  return newest;
};

const STATE_WORDS: Readonly<Record<SessionState, string>> = {
  starting: "Starting",
  working: "Working",
  "needs-you": "Needs you",
  idle: "Idle",
  "in-terminal": "In the terminal",
  dormant: "Dormant",
  failed: "Failed",
  limited: "At its usage limit",
  archived: "Archived",
};

/** The thread header's second line: its state, then the rest ("turn 24 · polaris"). */
export interface HeaderLine {
  readonly state: string;
  readonly rest: string;
}

/** "09:05": a moment in the phone's time; null when it isn't one. */
export const clockOf = (at: Date): string | null =>
  Number.isNaN(at.getTime())
    ? null
    : `${at.getHours().toString().padStart(2, "0")}:${at.getMinutes().toString().padStart(2, "0")}`;

/**
 * The thread header's second line (MX-E). While the Host is away it says when the state was last
 * known, "Working · as of 11:42", never passing the last state off as live (MX-AV, ENG-550).
 */
export const headerLine = (
  session: Pick<Session, "state" | "turnCount" | "currentUserTurn">,
  place: string | null,
  asOf: string | null = null
): HeaderLine => {
  const turn =
    session.turnCount > 0 ? `turn ${session.currentUserTurn?.number ?? session.turnCount}` : null;

  return {
    state: STATE_WORDS[session.state],
    rest: [asOf === null ? null : `as of ${asOf}`, turn, place]
      .filter((part) => part !== null && part !== "")
      .join(" · "),
  };
};

/** "Turn 23 · 11:42": the long-press menu's first header line, in the phone's time. */
export const turnHeading = (facts: Pick<TurnFacts, "number" | "startedAt">): string => {
  return [`Turn ${facts.number}`, clockOf(new Date(facts.startedAt))]
    .filter((part) => part !== null)
    .join(" · ");
};
