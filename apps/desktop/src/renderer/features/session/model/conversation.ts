/**
 * The conversation as a flat list of rows, the unit the virtualized list
 * renders: a folded Turn is one summary row, an open one expands into the
 * prompt, each item and the Turn's ending. A Turn here is the one the UI shows
 * (`turnGroups.ts`): a Turn the Harness started folds into the one before it.
 * Turns that were already there when the session was first shown start folded;
 * the latest one then and every Turn after it stay open until the user folds
 * them. Rows are cached per Turn view (`turnRows.ts`).
 */
import type {
  ApprovalRequest,
  Attachment,
  TurnId,
  TurnItem,
  TurnStatus,
  WorktreeSetupRun,
} from "@polaris/protocol";
import { Predicate } from "effect";
import type { SecretOutcome, SettledSecret, TurnView } from "../../../store/sessionModel.ts";
import { isWaiting, type Waiting } from "./background.ts";
import { formatElapsed, plural } from "./format.ts";
import { quietOpening } from "./idleCompaction.ts";
import type { ShellView } from "./items.ts";
import type { Outgoing } from "./outbox.ts";
import type { Entry } from "./runs.ts";
import type { Source } from "./sources/index.ts";
import { groupTurns, lastView, openingView, shownItems, type TurnGroup } from "./turnGroups.ts";
import { noTitles, type SubagentTitles, subagentTitles } from "./subagentTitles.ts";
import { partRows } from "./turnRows.ts";

const pad = (n: number) => String(n).padStart(2, "0");

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** When a Turn started, in local time: "14:02" today, "Sep 20 14:02" before. */
export const turnTime = (iso: string, now: Date): string => {
  const at = new Date(iso);

  if (Number.isNaN(at.getTime())) return "";
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;

  if (sameDay(at, now)) return clock;
  const day = at.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return at.getFullYear() === now.getFullYear()
    ? `${day} ${clock}`
    : `${day}, ${at.getFullYear()} ${clock}`;
};

/** Loading Turns older than the feed's first (`session.turns`). */
export type OlderState = "idle" | "loading" | "failed";

/** The row that opens the list while older Turns remain on the Host. */
export const olderRow = (state: OlderState): Row => ({ kind: "older", key: "older", state });

export interface TurnSummary {
  /** The shown Turn's id (its first Turn's). */
  readonly turnId: TurnId;
  /** The last Turn it covers: its diff runs to that one's checkpoint. */
  readonly lastTurnId: TurnId;
  /** One-based, as the UI numbers Turns. */
  readonly number: number;
  readonly status: TurnStatus;
  /** The last assistant message's first line, else the prompt's. */
  readonly summary: string;
  readonly files: number;
  /** Commands it ran (shell commands, not tool calls). */
  readonly commands: number;
  /** When the Turn started (ISO). */
  readonly startedAt: string;
  /** When its last Turn ended (ISO); null while it runs. */
  readonly endedAt: string | null;
}

export type Row =
  | { readonly kind: "setup"; readonly key: string; readonly setup: WorktreeSetupRun }
  | ({ readonly kind: "summary"; readonly key: string } & TurnSummary)
  | {
      readonly kind: "prompt";
      readonly key: string;
      readonly turnId: string;
      /** One-based, as the UI numbers Turns. */
      readonly number: number;
      readonly text: string;
      /** What the prompt carried, in the order attached (previews above the bubble). */
      readonly attachments: ReadonlyArray<Attachment>;
      /** The Model and effort the Turn ran on; null for the Harness's defaults. */
      readonly model: string | null;
      readonly effort: string | null;
      /** When the Turn started (ISO). */
      readonly startedAt: string;
      /** The user's shell command (`!`) with its output, in place of the prompt's text. */
      readonly shell?: ShellView | null;
    }
  /** A Turn the Harness started itself: what woke it, in place of a prompt. */
  | {
      readonly kind: "trigger";
      readonly key: string;
      /** The shown Turn it is in. */
      readonly turnId: string;
      /** The Harness-started Turn itself. */
      readonly partId: string;
      /** It opens the shown Turn (no user Turn before it), so it carries the fold control. */
      readonly opensTurn: boolean;
      readonly number: number;
      readonly text: string;
      readonly model: string | null;
      readonly effort: string | null;
      readonly startedAt: string;
    }
  | {
      readonly kind: "item";
      readonly key: string;
      /** The shown Turn it is in. */
      readonly turnId: string;
      /** The Turn it came in, which may be a Harness-started one inside the shown Turn. */
      readonly partId: string;
      /** One item, a folded tool run, or a Subagent. */
      readonly entry: Entry;
      /** The first agent row of its Turn carries the Harness avatar. */
      readonly lead: boolean;
      /** Its shown Turn is the session's latest (in-Turn defaults read it). */
      readonly latest: boolean;
      /** When a single item started (ISO); null for runs, Subagents, or no stamp. */
      readonly startedAt: string | null;
      /** On the lead row: the Turn's sources, shown across from the avatar. */
      readonly sources?: ReadonlyArray<Source> | undefined;
    }
  | {
      readonly kind: "approval";
      readonly key: string;
      readonly request: ApprovalRequest;
      /** A Secret Request that ended while shown: how, so its card says so; else null. */
      readonly settled: SecretOutcome | null;
    }
  /** A steer or queued follow-up that hasn't landed yet (`outbox.ts`). */
  | { readonly kind: "outgoing"; readonly key: string; readonly entry: Outgoing }
  /** An Idle session's background tasks still running: what it waits on. */
  | {
      readonly kind: "waiting";
      readonly key: string;
      readonly waiting: Waiting;
    }
  /** Turns before the first one loaded: being fetched as the list reaches the top, or failed. */
  | { readonly kind: "older"; readonly key: string; readonly state: OlderState }
  /** Whatever the session's chrome closes the list with (a Claim card). */
  | { readonly kind: "trailer"; readonly key: string }
  | {
      readonly kind: "ending";
      readonly key: string;
      readonly turnId: string;
      readonly number: number;
      readonly status: "interrupted" | "failed";
      /** The last Turn was interrupted by a restart: offer Continue. */
      readonly canContinue: boolean;
      /** The last Turn failed: offer Retry, which sends its prompt again. */
      readonly canRetry: boolean;
    };

const firstLine = (text: string) => {
  const line = text.trimStart().split("\n", 1)[0] ?? "";

  return line.trim();
};

const touchedFiles = (items: ReadonlyArray<TurnItem>): number => {
  const paths = new Set<string>();

  for (const item of items) {
    if (Predicate.isTagged(item, "FileChange")) for (const c of item.changes) paths.add(c.path);
  }

  return paths.size;
};

type AssistantMessage = Extract<TurnItem, { readonly _tag: "AssistantMessage" }>;

const isMessage = (item: TurnItem): item is AssistantMessage =>
  Predicate.isTagged(item, "AssistantMessage");

/** What started a Turn, in words: its prompt, or what woke a Turn the Harness started. */
export const turnOpening = (turn: TurnView["turn"]): string => quietOpening(turn) ?? turn.prompt;

export const summarize = (group: TurnGroup): TurnSummary => {
  const items = shownItems(group);
  const lastMessage = items.findLast(isMessage);
  const opening = openingView(group).turn;
  const last = lastView(group).turn;

  return {
    turnId: group.id,
    lastTurnId: last.id,
    number: group.number,
    status: last.status,
    summary: firstLine(lastMessage === undefined ? turnOpening(opening) : lastMessage.text),
    files: touchedFiles(items),
    commands: items.filter((item) => Predicate.isTagged(item, "CommandExecution")).length,
    startedAt: opening.startedAt,
    endedAt: last.endedAt,
  };
};

/** A finished Turn's receipt: "4 files · 2 commands · 1m 41s", leaving out what it didn't do. */
export const turnReceipt = (summary: TurnSummary): string => {
  const took =
    summary.endedAt === null
      ? Number.NaN
      : Date.parse(summary.endedAt) - Date.parse(summary.startedAt);

  return [
    summary.files === 0 ? null : plural(summary.files, "file"),
    summary.commands === 0 ? null : plural(summary.commands, "command"),
    Number.isNaN(took) ? null : formatElapsed(took),
  ]
    .filter((part) => part !== null)
    .join(" · ");
};

interface Folded {
  readonly views: ReadonlyArray<TurnView>;
  readonly number: number;
  readonly row: Row;
}

const folded = new WeakMap<TurnView, Folded>();

const sameViews = (a: ReadonlyArray<TurnView>, b: ReadonlyArray<TurnView>) =>
  a.length === b.length && a.every((v, n) => v === b[n]);

/** A folded Turn's one row; the same object while its Turns are unchanged. */
const summaryRow = (group: TurnGroup): Row => {
  const opening = openingView(group);
  const hit = folded.get(opening);

  if (hit !== undefined && hit.number === group.number && sameViews(hit.views, group.views))
    return hit.row;
  const row: Row = { kind: "summary", key: `${group.id}:summary`, ...summarize(group) };

  folded.set(opening, { views: group.views, number: group.number, row });

  return row;
};

/**
 * One shown Turn's rows: folded, its summary; open, each of its Turns' rows in order.
 * `latest`: it is the session's latest; `lastTurnId`: the session's last Turn.
 */
export const groupRows = (
  group: TurnGroup,
  expanded: boolean,
  latest: boolean,
  lastTurnId: string | null,
  titles: SubagentTitles = noTitles
): ReadonlyArray<Row> => {
  if (!expanded) return [summaryRow(group)];
  const { id: turnId, number } = group;

  return group.views.flatMap((view, n) =>
    partRows(view, {
      turnId,
      number,
      opens: n === 0,
      latest,
      isLast: view.turn.id === lastTurnId,
      titles,
    })
  );
};

/** Which Turns are open: the user's own choices, else from `openFrom` on. */
export interface Folds {
  /** Per shown Turn, what the user chose: true opened, false folded. */
  readonly chosen: ReadonlyMap<string, boolean>;
  /** The latest Turn when the session was first shown; null until then (the last Turn). */
  readonly openFrom: string | null;
}

export const noFolds: Folds = { chosen: new Map(), openFrom: null };

/** Whether each shown Turn is open; a newer Turn arriving never folds one. */
export const openTurns = (
  groups: ReadonlyArray<TurnGroup>,
  { chosen, openFrom }: Folds
): ReadonlyArray<boolean> => {
  const from = groups.findIndex((g) => g.views.some((v) => v.turn.id === openFrom));
  const first = from === -1 ? groups.length - 1 : from;

  return groups.map((group, n) => chosen.get(group.id) ?? n >= first);
};

/** Whether the session's latest Turn is open (T-ITEMS opens its runs by default). */
export const latestTurnOpen = (turns: ReadonlyArray<TurnView>, folds: Folds): boolean =>
  openTurns(groupTurns(turns), folds).at(-1) ?? false;

export interface ConversationInput {
  readonly turns: ReadonlyArray<TurnView>;
  readonly approvals: ReadonlyArray<ApprovalRequest>;
  /** Secret Requests settled while this feed was open; their cards stay where they asked. */
  readonly settledSecrets?: ReadonlyArray<SettledSecret>;
  /** Which Turns are open; default: only the last. */
  readonly folds?: Folds;
  /** Steers and follow-ups not landed yet; they close the list. */
  readonly setup?: WorktreeSetupRun | null;
  readonly outbox?: ReadonlyArray<Outgoing>;
  /** What an Idle session waits on (`waitingFor`); it follows the last Turn. */
  readonly waiting?: Waiting | null;
}

const approvalRow = (request: ApprovalRequest, settled: SecretOutcome | null = null): Row => ({
  kind: "approval",
  key: `approval:${request.id}`,
  request,
  settled,
});

/** Every row, in order; pending approvals follow the Turn that asked, or close the list. */
export const conversationRows = ({
  turns,
  approvals,
  settledSecrets = [],
  folds = noFolds,
  outbox = [],
  setup = null,
  waiting = null,
}: ConversationInput): ReadonlyArray<Row> => {
  const rows: Array<Row> = setup === null ? [] : [{ kind: "setup", key: setup.id, setup }];
  const placed = new Set<string>();
  const groups = groupTurns(turns);
  const lastGroup = groups.length - 1;
  const lastTurnId = turns.at(-1)?.turn.id ?? null;
  const open = openTurns(groups, folds);
  const titles = subagentTitles(turns);

  groups.forEach((group, n) => {
    rows.push(...groupRows(group, open[n] ?? true, n === lastGroup, lastTurnId, titles));
    const ids = new Set(group.views.map((v) => v.turn.id));

    for (const { request, outcome } of settledSecrets)
      if (ids.has(request.turnId)) rows.push(approvalRow(request, outcome));

    for (const request of approvals) {
      if (!ids.has(request.turnId)) continue;
      rows.push(approvalRow(request));
      placed.add(request.id);
    }
  });

  for (const request of approvals) if (!placed.has(request.id)) rows.push(approvalRow(request));

  if (waiting !== null && isWaiting(waiting))
    rows.push({ kind: "waiting", key: "waiting", waiting });

  for (const entry of outbox) rows.push({ kind: "outgoing", key: `outgoing:${entry.id}`, entry });

  return rows;
};

/** The row a shown Turn starts at (its summary, prompt or opening trigger); -1 when it isn't listed. */
export const turnStartRow = (rows: ReadonlyArray<Row>, turnId: string): number =>
  rows.findIndex(
    (r) =>
      (r.kind === "summary" || r.kind === "prompt" || (r.kind === "trigger" && r.opensTurn)) &&
      r.turnId === turnId
  );
