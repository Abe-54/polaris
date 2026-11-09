/**
 * What the constellation screen's presses open and what its chip and notice say (Paper MX-W,
 * MX-AA, MX-AB, MX-AC). Pure; the screen renders it.
 */
import type { Constellation, ConstellationStats, Turn } from "@polaris/protocol";
import { type ConstellationSource, constellationView, type TaskRow } from "../model.ts";
import { type PriceUsage, usd } from "../stats/model.ts";
import type { StarChartData } from "./stars.ts";

/** The stats chip's reading: the reported cost before the run time, when every token is priced. */
export const chipReading = (
  runTime: string,
  stats: ConstellationStats | null,
  price: PriceUsage
): string => {
  const cost = stats === null ? null : price(stats.usage.total);

  return cost === null || cost <= 0 ? runTime : `${usd(cost)} · ${runTime}`;
};

export interface ClaimNotice {
  /** The claim the notice opens: the first handed to the user, in plan order. */
  readonly taskId: string;
  /** "B3's claim is handed to you", or "2 claims are handed to you". */
  readonly text: string;
}

/** Claims handed to the user, in plan order, with every group opened so none is folded away. */
const handedRows = (source: ConstellationSource, now: number): ReadonlyArray<TaskRow> => {
  const groups = source.constellation.tasks.flatMap((t) => (t.group == null ? [] : [t.group]));
  const open = new Map(groups.map((g) => [g, true]));

  return constellationView(source, now, open).rows.filter(
    (r): r is TaskRow => r.kind === "task" && r.handed !== null
  );
};

/** The lead's notice over the composer while claims wait on the user's verdict; null when none. */
export const claimNotice = (
  source: ConstellationSource,
  chart: StarChartData,
  now: number
): ClaimNotice | null => {
  const handed = handedRows(source, now);
  const first = handed[0];

  if (first === undefined) return null;
  const label = chart.tasks.find((t) => t.id === first.id)?.label ?? first.id;

  return {
    taskId: first.id,
    text:
      handed.length === 1
        ? `${label}'s claim is handed to you`
        : `${handed.length} claims are handed to you`,
  };
};

/** The completion card shows once the constellation is completed or archived (ENG-532). */
export const completes = (state: Constellation["state"]): boolean =>
  state === "completed" || state === "archived";

/** The completion card's "Review turn 31": the lead's last Turn, once it has ended (ENG-575). */
export const reviewTurnOf = (
  last: Turn | null
): { readonly label: string; readonly turnId: string } | null =>
  last === null || last.status === "working"
    ? null
    : { label: `Review turn ${last.userTurnNumber ?? last.index + 1}`, turnId: last.id };
