/**
 * Usage → By constellation (DESIGN.md, SR-05; spec §9): each Constellation's cost as a bar split
 * lead / workers, its workers and wall-clock time; a row opens to its Tasks. The first three, then
 * "Show all". Computed when shown, from the buckets.
 */
import { SettingsButton, SettingsCard, SettingsWell } from "@polaris/ui";
import { useMemo, useState } from "react";
import { useApp } from "../../../shell/hooks.ts";
import { type ConstellationView, useAllConstellations } from "../../sessions/source.ts";
import { useConstellationStats } from "../constellationStats.ts";
import { byConstellation, type ConstellationSpend, duration } from "../model/byConstellation.ts";
import {
  addCost,
  type Bucket,
  compactTokens,
  type Cost,
  costLabel,
  type Estimator,
  NO_COST,
} from "../model/usage.ts";

/** Rows shown before "Show all" (Paper SR-05). */
const FIRST = 3;

const BAR = 240;

const HEAD = "text-text-subtle font-mono text-[10px] leading-3 tracking-[0.06em] uppercase";

const MONO = "text-text-subtle shrink-0 text-right font-mono text-[12px] leading-4 tabular";

/** Bars share one scale: the costliest constellation fills it; tokens when nothing is priced. */
const sizeOf = (spend: ConstellationSpend, byCost: boolean) =>
  byCost ? spend.total.cost.usd : spend.total.tokens;

const leadShare = (spend: ConstellationSpend, byCost: boolean) => {
  const total = sizeOf(spend, byCost);
  const lead = byCost ? spend.lead.cost.usd : spend.lead.tokens;

  return total === 0 ? 0 : lead / total;
};

/** Distinct worker sessions: an Attempt sent back and retried in the same session is one worker. */
const workerCount = (view: ConstellationView) =>
  new Set(
    view.constellation.attempts
      .filter((a) => a.sessionId !== view.constellation.leadSessionId)
      .map((a): string => a.sessionId)
  ).size;

/** "polaris · Mac Studio, Linux VM": its workspace on the lead's host, then every host it ran on. */
const useWhere = () => {
  const hosts = useApp((s) => s.hosts);
  const models = useApp((s) => s.hostModels);

  return (view: ConstellationView) => {
    const c = view.constellation;

    const labelOf = (hostId: string) =>
      hosts.find((h) => h.status.host?.hostId === hostId)?.label ?? null;

    const leadKey = hosts.find((h) => h.status.host?.hostId === c.hostId)?.key;

    const workspace =
      leadKey === undefined ? undefined : models[leadKey]?.workspaces.get(c.workspaceId);

    const ran = [...new Set([c.hostId, ...c.attempts.map((a): string => a.hostId)])].flatMap(
      (id) => labelOf(id) ?? []
    );

    return [workspace?.name, ran.join(", ")]
      .filter((part) => part !== undefined && part !== "")
      .join(" · ");
  };
};

const CostBar = ({
  spend,
  width,
  share,
}: {
  readonly spend: ConstellationSpend;
  readonly width: number;
  readonly share: number;
}) => (
  <span className="flex min-w-0 flex-1 items-center gap-2.5">
    <span
      aria-hidden
      className="flex h-2 shrink-0 gap-0.5 overflow-clip rounded-[2px]"
      style={{ width: Math.max(4, Math.round(width)) }}
      data-testid="constellation-cost-bar"
      data-lead={share.toFixed(2)}
    >
      <span className="bg-text-strong shrink-0" style={{ width: `${share * 100}%` }} />
      <span className="bg-text-subtle min-w-0 flex-1" />
    </span>
    <span className="text-text-strong tabular font-mono text-[12px] leading-4 font-medium">
      {costLabel(spend.total.cost)}
    </span>
  </span>
);

const Tasks = ({ spend }: { readonly spend: ConstellationSpend }) =>
  spend.tasks.map((t) => (
    <div
      key={t.taskId}
      className="px-panel flex h-8 items-center gap-3 pl-[calc(var(--spacing-panel)+12px)]"
    >
      <span className="text-text-subtle w-7 shrink-0 font-mono text-[11px]">{t.taskId}</span>
      <span className="text-caption text-text-subtle min-w-0 flex-1 truncate">
        {t.title}
        {t.attempts > 1 ? ` · ${t.attempts} attempts` : ""}
      </span>
      <span className={`${MONO} w-16`}>{compactTokens(t.tokens)}</span>
      <span className={`${MONO} w-[72px]`}>{costLabel(t.cost)}</span>
    </div>
  ));

const Row = ({
  spend,
  where,
  workers,
  width,
  share,
}: {
  readonly spend: ConstellationSpend;
  readonly where: string;
  readonly workers: number;
  readonly width: number;
  readonly share: number;
}) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        data-testid="usage-constellation"
        className="px-panel hover:bg-fill-hover flex cursor-default items-center gap-3 py-3 text-left"
      >
        <span className="flex w-[260px] shrink-0 flex-col">
          <span className="text-body text-text-default truncate">{spend.name}</span>
          <span className="text-caption text-text-subtle truncate">{where}</span>
        </span>
        <CostBar spend={spend} width={width} share={share} />
        <span className={`${MONO} w-16`} data-testid="constellation-workers">
          {workers}
        </span>
        <span className={`${MONO} w-[72px]`}>{duration(spend.durationMs)}</span>
      </button>
      {open ? <Tasks spend={spend} /> : null}
    </div>
  );
};

export const UsageByConstellation = ({
  buckets,
  now,
  estimate,
  days,
  total,
}: {
  readonly buckets: ReadonlyArray<Bucket>;
  readonly now: number;
  readonly estimate: Estimator;
  readonly days: number;
  /** Usage's whole cost over the same range, for "$89.35 of $312.40". */
  readonly total: Cost;
}) => {
  const all = useAllConstellations();
  const views = useMemo(() => Object.values(all).flat(), [all]);
  const stats = useConstellationStats(views);
  const where = useWhere();
  const [expanded, setExpanded] = useState(false);

  const rows = useMemo(
    () => byConstellation({ buckets, views, stats, now, estimate }),
    [buckets, views, stats, now, estimate]
  );

  if (rows.length === 0) return null;

  const byId = new Map(views.map((v): [string, ConstellationView] => [v.constellation.id, v]));
  const byCost = rows.some((r) => r.total.cost.usd > 0);
  const largest = Math.max(...rows.map((r) => sizeOf(r, byCost)));
  const shown = expanded ? rows : rows.slice(0, FIRST);
  const spent = rows.reduce((c, r) => addCost(c, r.total.cost), NO_COST);
  const notes = [...new Set(rows.flatMap((r) => r.notes))];

  const status = [
    `${rows.length} ${rows.length === 1 ? "constellation" : "constellations"}`,
    `${costLabel(spent)} of ${costLabel(total)}`,
  ].join(" · ");

  return (
    <SettingsCard
      title="By constellation"
      aside={`Lead and workers together, last ${days} days`}
      status={status}
      action={
        rows.length <= FIRST ? undefined : (
          <SettingsButton onClick={() => setExpanded(!expanded)}>
            {expanded ? "Show fewer" : `Show all ${rows.length}`}
          </SettingsButton>
        )
      }
      data-testid="usage-by-constellation"
    >
      <SettingsWell>
        <div className="px-panel flex items-center gap-3 py-2">
          <span className={`${HEAD} w-[260px] shrink-0`}>Constellation</span>
          <span className={`${HEAD} flex-1`}>Cost · lead / workers</span>
          <span className={`${HEAD} w-16 text-right`}>Workers</span>
          <span className={`${HEAD} w-[72px] text-right`}>Time</span>
        </div>
        {shown.map((spend) => {
          const view = byId.get(spend.id);

          return (
            <Row
              key={spend.id}
              spend={spend}
              where={view === undefined ? "" : where(view)}
              workers={view === undefined ? 0 : workerCount(view)}
              width={largest === 0 ? 0 : (sizeOf(spend, byCost) / largest) * BAR}
              share={leadShare(spend, byCost)}
            />
          );
        })}
        {[
          ...(rows.some((r) => r.source === "stats")
            ? ["Since each started, per response, from its lead's host."]
            : []),
          ...notes,
        ].map((note) => (
          <p
            key={note}
            className="px-panel text-caption text-text-subtle py-2.5"
            data-testid="usage-constellation-note"
          >
            {note}
          </p>
        ))}
      </SettingsWell>
    </SettingsCard>
  );
};
