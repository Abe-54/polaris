/**
 * How a Data Source reads in the connection bar, its card and the tree (DESIGN.md, Data →
 * Connection bar; rule/data-source-label): the label's tone, the driver line and agent access.
 */
import type { DataSource, DataSourceLabel } from "@polaris/protocol";

export type LabelColour = DataSourceLabel["colour"];

/** The card's swatches in order: no colour, then rule/data-source-label's five presets. */
export const LABEL_COLOURS: ReadonlyArray<LabelColour> = [
  "none",
  "grey",
  "green",
  "blue",
  "tan",
  "red",
];

export interface LabelTone {
  /** The kicker on a coloured bar; never the access words (rule/data-source-label). */
  readonly text: string;
  /** The 6px dot by the name in the tree, and the card's swatch. */
  readonly fill: string;
  /** The bar's ground at 12% and its ring. */
  readonly ground: string;
}

export const LABEL_TONES: Record<LabelColour, LabelTone> = {
  none: { text: "text-text-subtle", fill: "", ground: "bg-well ring-hairline" },
  grey: {
    text: "text-text-subtle",
    fill: "bg-text-subtle",
    ground: "bg-text-subtle/12 ring-text-subtle/30",
  },
  green: {
    text: "text-diff-added-text",
    fill: "bg-diff-added",
    ground: "bg-diff-added/12 ring-diff-added/40",
  },
  blue: {
    text: "text-data-label-blue",
    fill: "bg-data-label-blue",
    ground: "bg-data-label-blue/12 ring-data-label-blue/40",
  },
  tan: {
    text: "text-git-modified-text",
    fill: "bg-git-modified",
    ground: "bg-git-modified/12 ring-git-modified/40",
  },
  red: {
    text: "text-severity-critical-text",
    fill: "bg-severity-critical",
    ground: "bg-severity-critical/12 ring-severity-critical/50",
  },
};

export const LABEL_NAMES: Record<LabelColour, string> = {
  none: "No colour",
  grey: "Grey",
  green: "Green",
  blue: "Blue",
  tan: "Tan",
  red: "Red",
};

/** The kicker: the label text given (the saved one by default), else where the source is (a branch's name, LOCAL or REMOTE). */
export const kickerText = (source: DataSource, text = source.label.text): string => {
  if (text.trim() !== "") return text.trim().toUpperCase();

  return (source.branch?.name ?? source.locality).toUpperCase();
};

/**
 * A source the user adds starts red with no text: only the Host knows whether a database
 * server is its own (a loopback port may be a tunnel), so the label fails closed until chosen.
 */
export const MANUAL_LABEL: DataSourceLabel = { text: "", colour: "red" };

const ENGINES: Record<DataSource["engine"], string> = { postgres: "PostgreSQL", mysql: "MySQL" };

const PROVIDERS: Record<NonNullable<DataSource["branch"]>["provider"], string> = {
  planetscale: "PlanetScale",
  neon: "Neon",
};

export const engineName = (engine: DataSource["engine"]) => ENGINES[engine];

/** "PostgreSQL 16.4", "MySQL 8.0 · PlanetScale": the engine, its major.minor and a branch's provider. */
export const driverText = (source: DataSource): string => {
  const version = /^\d+(\.\d+)?/.exec(source.version ?? "")?.[0];

  const engine =
    version === undefined ? ENGINES[source.engine] : `${ENGINES[source.engine]} ${version}`;

  return source.branch === undefined ? engine : `${engine} · ${PROVIDERS[source.branch.provider]}`;
};

/** The bar's mono line before the table: driver, where (a branch's name or host:port), database. */
export const barParts = (source: DataSource): ReadonlyArray<string> => [
  driverText(source),
  source.branch?.name ?? `${source.host}:${source.port}`,
  source.database,
];

/** A Remote Data Source agents can't reach until the user approves it (or after a denial). */
export const isLocked = (source: DataSource) =>
  source.locality === "remote" &&
  (source.access === "needs-approval" || source.access === "denied");

const WRITES: Record<DataSource["writes"], string> = { ask: "writes ask you", off: "writes off" };

const ACCESS: Record<DataSource["access"], (source: DataSource) => string> = {
  read: (s) => `Agents read · ${WRITES[s.writes]}`,
  approved: (s) =>
    s.writes === "off" ? "Approved · agents read only" : `Approved · ${WRITES[s.writes]}`,
  "needs-approval": () => "Agents can't reach it until you approve it",
  denied: () => "Denied · agents can't reach it",
};

/** The agents' access, at the bar's end (DESIGN.md, Data → Connection bar). */
export const accessText = (source: DataSource): string => ACCESS[source.access](source);

const SHORT: Record<DataSource["access"], (source: DataSource) => string> = {
  read: (s) => (s.writes === "off" ? "Read only" : "Read · writes ask"),
  approved: (s) => (s.writes === "off" ? "Approved · read only" : "Approved · writes ask"),
  "needs-approval": () => "Not approved",
  denied: () => "Denied",
};

/** The same facts in a narrow bar, so the access is the last thing to go, never clipped. */
export const accessShort = (source: DataSource): string => SHORT[source.access](source);

/** The card's AGENTS line: the same facts, lowercase. */
export const accessLine = (source: DataSource): string => {
  const reads: Record<DataSource["access"], string> = {
    read: "read",
    approved: "approved · read",
    "needs-approval": "not approved",
    denied: "denied",
  };

  return isLocked(source)
    ? reads[source.access]
    : `${reads[source.access]} · ${WRITES[source.writes]}`;
};

/** Connected, can't reach it (with why), or not tried yet: an unprobed source is never "down". */
export const statusText = (source: DataSource) => {
  if (source.reachable === undefined) return "not connected yet";

  if (source.reachable) return "connected";

  return `can't reach it${source.error === undefined ? "" : ` · ${source.error}`}`;
};

/** Where discovery found it (".env.local · DATABASE_URL"), or that the user added it. */
export const foundText = (source: DataSource): string => {
  const { kind, file, key } = source.foundIn;

  if (kind === "manual") return "added by you";

  return [file, key].filter((part) => part !== undefined && part !== "").join(" · ") || kind;
};

const UNITS = [
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "k"],
] as const;

/** Rows read as estimates: 962, 1.3k, 12k, 4.1M; empty when the database gave none. */
export const formatEstimate = (n: number | null): string => {
  if (n === null) return "";

  const [size, unit] = UNITS.find(([at]) => n >= at) ?? [1, ""];
  const value = n / size;

  if (size === 1) return String(n);

  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)}${unit}`;
};
