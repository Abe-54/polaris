/**
 * The Sessions section's Active order (ENG-609): needs you, then working, then idle, then
 * dormant, each tier in sidebar order. Pure, so it is tested.
 */
import type { SessionState } from "@polaris/protocol";
import { needsYou } from "../../../routes/topBar.ts";
import type { SessionEntry } from "../../../store/hostModel.ts";
import { waitingOn } from "../../session/model/background.ts";
import type { LeadGroup, WorkerState } from "./leadGroups.ts";

export const TIERS = ["needs-you", "working", "idle", "dormant"] as const;

export type Tier = (typeof TIERS)[number];

/** A tier divider's words; the count follows ("Working · 3"). */
export const TIER_LABELS: Readonly<Record<Tier, string>> = {
  "needs-you": "Needs you",
  working: "Working",
  idle: "Idle",
  dormant: "Dormant",
};

/** Stopped on the user's side: the Needs you view lists these as "Also waiting on you". */
const WAITING_ON_YOU: ReadonlySet<SessionState> = new Set(["failed", "limited", "in-terminal"]);

const RUNNING: ReadonlySet<SessionState> = new Set(["starting", "working"]);

const BUSY_WORKERS: ReadonlySet<WorkerState> = new Set([
  "working",
  "starting",
  "setting-up",
  "waiting-slot",
  "waiting-background",
]);

/** A session's tier; an Idle one still waiting on background tasks counts as working. */
export const tierOf = (entry: SessionEntry): Tier => {
  const { state } = entry.session;

  if (needsYou(entry) || WAITING_ON_YOU.has(state)) return "needs-you";

  if (RUNNING.has(state) || waitingOn(entry.session).length > 0) return "working";

  return state === "dormant" ? "dormant" : "idle";
};

/** A Lead row's tier rolls up its workers: any that needs you or works lifts it. */
export const groupTierOf = (
  group: Pick<LeadGroup, "lead" | "needsYou"> & {
    readonly workers: ReadonlyArray<{ readonly state: WorkerState }>;
  }
): Tier => {
  if (group.needsYou > 0) return "needs-you";

  const own = tierOf(group.lead);

  return own !== "working" && group.workers.some((w) => BUSY_WORKERS.has(w.state))
    ? "working"
    : own;
};

const rank = (tier: Tier) => TIERS.indexOf(tier);

/** Stable: within a tier, rows keep the order they came in. */
export const byTier = <T>(items: ReadonlyArray<T>, tier: (item: T) => Tier): ReadonlyArray<T> =>
  items
    .map((item, index) => ({ item, index, rank: rank(tier(item)) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) => item);

export interface TierRun<T> {
  readonly tier: Tier;
  readonly items: ReadonlyArray<T>;
}

/** Consecutive rows of one tier, for the dividers. */
export const tierRuns = <T>(
  items: ReadonlyArray<T>,
  tier: (item: T) => Tier
): ReadonlyArray<TierRun<T>> =>
  items.reduce<Array<TierRun<T>>>((runs, item) => {
    const t = tier(item);
    const last = runs.at(-1);

    if (last?.tier === t) runs[runs.length - 1] = { tier: t, items: [...last.items, item] };
    else runs.push({ tier: t, items: [item] });

    return runs;
  }, []);

/**
 * The order to show while the pointer is over the list: rows keep their last places, new
 * ones go last. Null `held` shows `items` as they are.
 */
export const heldOrder = <T>(
  items: ReadonlyArray<T>,
  key: (item: T) => string,
  held: ReadonlyArray<string> | null
): ReadonlyArray<T> => {
  if (held === null) return items;

  const place = new Map(held.map((k, i) => [k, i]));
  const at = (item: T) => place.get(key(item)) ?? Number.MAX_SAFE_INTEGER;

  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => at(a.item) - at(b.item) || a.index - b.index)
    .map(({ item }) => item);
};
