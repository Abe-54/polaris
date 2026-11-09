/**
 * The review queue (Paper MX-K, with MX-M's clean lane) as data: the turns ready to review, the
 * one most in need of you first (open Criticals, then the rest of the tally), and the clean lane.
 * Pure, so the ordering is testable.
 */
import type { RiskFinding, RiskSummary } from "@polaris/protocol";
import { Match } from "effect";
import { openCriticals as criticalsOf } from "../accept/confirmation.ts";
import { counted, grouped, shortHostName } from "../../home/model/format.ts";
import type { SessionRow } from "../../home/model/home.ts";
import {
  type AcceptState,
  acceptState,
  isDismissed,
  listedFindings,
  SEVERITIES,
  type Tally,
  tally,
} from "../model.ts";
import type { Loaded } from "../useReview.ts";

const LOADING = { kind: "loading" } as const;

/** What the Host holds of a turn's Risk Summary. */
export type TurnRisk =
  | { readonly kind: "loading" }
  /** No summary is cached for the turn's head: nothing has read it yet. */
  | { readonly kind: "unreviewed" }
  | { readonly kind: "summary"; readonly summary: RiskSummary }
  | { readonly kind: "failed"; readonly message: string };

/** The reviewed turn of a ready agent session: its latest, which ended. */
export interface QueueTurn {
  readonly turnId: string;
  readonly number: number;
  /** Null until the diff's index is read. */
  readonly files: {
    readonly count: number;
    readonly added: number;
    readonly removed: number;
  } | null;
  readonly risk: TurnRisk;
}

export interface QueueItem {
  readonly row: SessionRow;
  /** Null while the turn is read. */
  readonly turn: QueueTurn | null;
  readonly tally: Tally;
  /** Listed findings, ranked: the hero shows the first. */
  readonly findings: ReadonlyArray<RiskFinding>;
}

export interface Queue {
  /** The hero's pages: every turn not in the clean lane, the most in need of you first. */
  readonly pages: ReadonlyArray<QueueItem>;
  /** Reviewed with no findings: accepted from the queue. */
  readonly clean: ReadonlyArray<QueueItem>;
  /** Open Criticals across the queue. */
  readonly critical: number;
  readonly total: number;
}

/** A turn read for one Turn count: a newer Turn makes it stale. */
export const turnKey = (row: SessionRow): string => `${row.key}:${row.session.turnCount}`;

const NO_FINDINGS: ReadonlyArray<RiskFinding> = [];

const summaryOf = (turn: QueueTurn | null): RiskSummary | null =>
  turn?.risk.kind === "summary" ? turn.risk.summary : null;

export const queueItem = (row: SessionRow, turn: QueueTurn | null): QueueItem => {
  const findings = summaryOf(turn)?.findings ?? NO_FINDINGS;

  return { row, turn, tally: tally(findings), findings: listedFindings(findings) };
};

/** Open Criticals: a dismissed one stays listed but no longer asks for the confirmation. */
export const openCriticals = (item: QueueItem): number => criticalsOf(item.findings).length;

/** Read to the end with nothing listed. A summary still reading may yet find something. */
export const isClean = (item: QueueItem): boolean => {
  const summary = summaryOf(item.turn);

  return summary !== null && summary.status === "completed" && item.findings.length === 0;
};

/** Open Criticals first, then the tally from Critical down, then the newest. */
export const byNeed = (a: QueueItem, b: QueueItem): number => {
  const critical = openCriticals(b) - openCriticals(a);

  if (critical !== 0) return critical;

  for (const severity of SEVERITIES) {
    const diff = b.tally[severity] - a.tally[severity];

    if (diff !== 0) return diff;
  }

  return b.row.since - a.row.since;
};

export const buildQueue = (items: ReadonlyArray<QueueItem>): Queue => {
  const clean = items.filter(isClean).sort((a, b) => b.row.since - a.row.since);
  const pages = items.filter((item) => !isClean(item)).sort(byNeed);

  return {
    pages,
    clean,
    critical: items.reduce((n, item) => n + openCriticals(item), 0),
    total: items.length,
  };
};

/** One lane under the hero: the turns waiting behind it, or the clean ones. */
export interface QueueLane {
  readonly kind: "waiting" | "clean";
  /** "waiting · 3", as its head reads. */
  readonly label: string;
  readonly data: ReadonlyArray<QueueItem>;
}

/** The lanes under the hero, in order; a lane with no turns is left out. */
export const queueLanes = (queue: Queue): ReadonlyArray<QueueLane> =>
  [
    { kind: "waiting" as const, data: queue.pages.slice(1) },
    { kind: "clean" as const, data: queue.clean },
  ].flatMap((lane) =>
    lane.data.length === 0
      ? []
      : [{ ...lane, label: `${lane.kind} · ${grouped(lane.data.length)}` }]
  );

/** "1 critical · 4 turns to review": the Critical part is the header's tinted half. */
export const queueSummary = (queue: Queue) => ({
  critical: queue.critical > 0 ? `${queue.critical} critical` : null,
  rest: `${counted(queue.total, "turn")} to review`,
});

/** "needs review · 1 of 4"; the kicker is set in capitals. */
export const heroKicker = (index: number, count: number): string =>
  count > 1 ? `needs review · ${index + 1} of ${count}` : "needs review";

const filesLabel = (turn: QueueTurn | null): string | null =>
  turn?.files == null ? null : counted(turn.files.count, "file");

const turnLabel = (item: QueueItem): string =>
  `Turn ${item.turn?.number ?? item.row.session.turnCount}`;

const parts = (...all: ReadonlyArray<string | null>) =>
  all.filter((part): part is string => part !== null).join(" · ");

/** The hero's line: "Turn 24 · mac-studio · 3 files". */
export const heroMeta = (item: QueueItem, withHost: boolean): string =>
  parts(turnLabel(item), withHost ? shortHostName(item.row.hostName) : null, filesLabel(item.turn));

/** A well's line: "Turn 3 · 2 files · lucas-rpi"; a clean one says "no findings" before the host. */
export const wellMeta = (item: QueueItem, withHost: boolean): string =>
  parts(
    turnLabel(item),
    filesLabel(item.turn),
    isClean(item) ? "no findings" : null,
    withHost ? shortHostName(item.row.hostName) : null
  );

/** What a well shows where its tally would be when there is none to show. */
export const riskNote = (item: QueueItem): string | null => {
  const risk = item.turn?.risk;

  if (risk === undefined || risk.kind === "loading") return null;

  if (risk.kind === "unreviewed") return "not reviewed";

  if (risk.kind === "failed") return "review failed";

  if (risk.summary.status === "running") return "reviewing…";

  if (risk.summary.status === "failed") return "review failed";

  if (item.findings.length === 0) return "no findings";

  const dismissed = item.findings.filter(isDismissed).length;

  return dismissed === item.findings.length ? `${dismissed} dismissed` : null;
};

const loadedRisk = (risk: TurnRisk | undefined): Loaded<RiskSummary> =>
  Match.value(risk ?? LOADING).pipe(
    Match.discriminatorsExhaustive("kind")({
      loading: (): Loaded<RiskSummary> => LOADING,
      unreviewed: (): Loaded<RiskSummary> => ({ kind: "failed", message: "Not reviewed yet" }),
      summary: ({ summary }): Loaded<RiskSummary> => ({ kind: "ready", value: summary }),
      failed: ({ message }): Loaded<RiskSummary> => ({ kind: "failed", message }),
    })
  );

/** Accept's state from the queue: the same rules as Review's, over what the queue read. */
export const queueAcceptState = (item: QueueItem, sending: boolean): AcceptState =>
  acceptState({
    risk: loadedRisk(item.turn?.risk),
    turnEnded: true,
    accepted: (item.row.session.acceptedThroughIndex ?? -1) >= item.row.session.turnCount - 1,
    sending,
  });
