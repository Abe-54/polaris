/**
 * A Host's live stats for Settings → Hosts (DESIGN.md, Settings → Hosts redesign): the
 * `host.stats` feed folded into a ring, the sparklines' and meters' cells, and the Vitals
 * figures with their captions. Pure, so every figure is tested.
 */
import { HostStatsItem, type HostStatsSample } from "@polaris/protocol";
import type { Plain } from "../../../../shared/api.ts";
import { ago } from "../model.ts";

export type Sample = Plain<HostStatsSample>;

export interface HostStats {
  readonly cores: number;
  readonly intervalMs: number;
  /** Oldest first, at most HISTORY. */
  readonly samples: ReadonlyArray<Sample>;
}

/** The Daemon keeps 60 (HOST_STATS_HISTORY); the Vitals charts show them all. */
export const HISTORY = 60;

/** The host list's sparkline: 40 samples, 80px. */
export const LIST_SAMPLES = 40;

/**
 * `History` replaces the ring; a `Sample` joins it, dropping the oldest past HISTORY. Items
 * arrive structured-cloned over IPC, so this branches on `_tag`: a Schema guard wants class instances.
 */
export const foldStats = (state: HostStats | null, item: HostStatsItem): HostStats | null =>
  HostStatsItem.match(item, {
    History: ({ cores, intervalMs, samples }) => ({
      cores,
      intervalMs,
      samples: samples.slice(-HISTORY),
    }),
    Sample: ({ sample }) =>
      state === null ? null : { ...state, samples: [...state.samples, sample].slice(-HISTORY) },
  });

/**
 * One column per sample, right-aligned in `count` columns: a bar's height in px, on 2px
 * steps, at least one step for any reading; null for an empty column (no sample, or none read).
 */
export const sparkBars = (
  values: ReadonlyArray<number | null>,
  count: number,
  maxHeight: number
): ReadonlyArray<number | null> => {
  const shown = values.slice(-count);
  const pad: ReadonlyArray<null> = Array.from({ length: count - shown.length }, () => null);
  const steps = Math.floor(maxHeight / 2);

  return [
    ...pad,
    ...shown.map((v) =>
      v === null ? null : Math.max(1, Math.round((Math.min(100, Math.max(0, v)) / 100) * steps)) * 2
    ),
  ];
};

/** Lit cells of a 40-cell meter (Usage's track): any use lights at least one. */
export const METER_CELLS = 40;

export const meterCells = (used: number, total: number): number => {
  if (total <= 0 || used <= 0) return 0;

  return Math.min(METER_CELLS, Math.max(1, Math.round((used / total) * METER_CELLS)));
};

export const cpuSeries = (stats: HostStats) => stats.samples.map((s) => s.cpuPercent);

/** Load as a share of the cores, so 24 cores fully busy reads as a full bar. */
export const loadSeries = (stats: HostStats) =>
  stats.samples.map((s) =>
    s.loadAverage === null || stats.cores <= 0 ? null : (s.loadAverage[0] / stats.cores) * 100
  );

const GIB = 1024 ** 3;

const TB = 1e12;

const GB = 1e9;

/** One decimal under 100, none above: "41.2", "128". */
const figure = (n: number) => (n < 100 ? String(Math.round(n * 10) / 10) : String(Math.round(n)));

/** A disk size in the unit its total reads best in: "2 TB", "512 GB". */
const diskUnit = (total: number) =>
  total >= TB ? { unit: "TB", size: TB } : { unit: "GB", size: GB };

export interface Vital {
  readonly kicker: string;
  /** "—" before the first sample and while the host isn't connected. */
  readonly figure: string;
  readonly unit: string;
  readonly caption: string;
}

const EMPTY = "—";

const latest = (stats: HostStats | null): Sample | null => stats?.samples.at(-1) ?? null;

export const cpuVital = (stats: HostStats | null, now: number): Vital => {
  const last = latest(stats);
  const read = (stats?.samples ?? []).filter((s) => s.cpuPercent !== null);

  const peak = read.reduce<Sample | null>(
    (best, s) => (best === null || (s.cpuPercent ?? 0) > (best.cpuPercent ?? 0) ? s : best),
    null
  );

  return {
    kicker: "CPU",
    figure: last?.cpuPercent == null ? EMPTY : String(Math.round(last.cpuPercent)),
    unit: "%",
    caption:
      peak === null
        ? "Peak —"
        : `Peak ${Math.round(peak.cpuPercent ?? 0)}% · ${ago(now - Date.parse(peak.at))}`,
  };
};

export const loadVital = (stats: HostStats | null): Vital => {
  const load = latest(stats)?.loadAverage ?? null;
  const cores = stats === null ? "" : `/ ${stats.cores} ${stats.cores === 1 ? "core" : "cores"}`;

  if (stats !== null && latest(stats) !== null && load === null)
    return { kicker: "LOAD", figure: EMPTY, unit: cores, caption: "Windows has no load average" };

  return {
    kicker: "LOAD",
    figure: load === null ? EMPTY : load[0].toFixed(2),
    unit: cores,
    caption: load === null ? "1 min" : `1 min · ${load[1].toFixed(2)} over 5 min`,
  };
};

export const memoryVital = (stats: HostStats | null): Vital & { readonly cells: number } => {
  const last = latest(stats);

  if (last === null || last.memoryTotalBytes === 0)
    return { kicker: "MEMORY", figure: EMPTY, unit: "", caption: "— used", cells: 0 };

  const share = last.memoryUsedBytes / last.memoryTotalBytes;

  return {
    kicker: "MEMORY",
    figure: figure(last.memoryUsedBytes / GIB),
    unit: `/ ${figure(last.memoryTotalBytes / GIB)} GB`,
    caption: `${Math.round(share * 100)}% used`,
    cells: meterCells(last.memoryUsedBytes, last.memoryTotalBytes),
  };
};

export const diskVital = (stats: HostStats | null): Vital & { readonly cells: number } => {
  const disk = latest(stats)?.disk ?? null;

  if (disk === null || disk.totalBytes === 0)
    return { kicker: "DISK", figure: EMPTY, unit: "", caption: "— free", cells: 0 };

  const { unit, size } = diskUnit(disk.totalBytes);
  const free = disk.totalBytes - disk.usedBytes;
  const freeUnit = diskUnit(free);

  return {
    kicker: "DISK",
    figure: figure(disk.usedBytes / size),
    unit: `/ ${figure(disk.totalBytes / size)} ${unit}`,
    caption: `${figure(free / freeUnit.size)} ${freeUnit.unit} free`,
    cells: meterCells(disk.usedBytes, disk.totalBytes),
  };
};

/** "3D 4H", "2H 05M", "12S": how long the daemon has been up, for mono footers. */
export const uptime = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));

  if (s < 60) return `${s}S`;
  const m = Math.floor(s / 60);

  if (m < 60) return `${m}M`;
  const h = Math.floor(m / 60);

  if (h < 24) return `${h}H ${String(m % 60).padStart(2, "0")}M`;

  return `${Math.floor(h / 24)}D ${h % 24}H`;
};

/** "LAST 2 MIN · 60 SAMPLES · UP 3D 4H": the window the charts cover. */
export const vitalsFooter = (stats: HostStats | null, upMs: number | null): string => {
  const up = upMs === null ? [] : [`UP ${uptime(upMs)}`];

  if (stats === null) return ["NO SAMPLES YET", ...up].join(" · ");
  const minutes = Math.max(1, Math.round((stats.samples.length * stats.intervalMs) / 60_000));

  return [`LAST ${minutes} MIN`, `${stats.samples.length} SAMPLES`, ...up].join(" · ");
};

/** "LIVE · EVERY 2S". */
export const liveLabel = (stats: HostStats | null): string =>
  stats === null ? "LIVE" : `LIVE · EVERY ${Math.round(stats.intervalMs / 1000)}S`;

/** The list's CPU lane: the latest reading, "—" when there is none. */
export const cpuFigure = (stats: HostStats | null): string => {
  const cpu = latest(stats)?.cpuPercent ?? null;

  return cpu === null ? EMPTY : `${Math.round(cpu)}%`;
};
