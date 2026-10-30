/**
 * The Sources tree as flat rows for the virtualized list (DESIGN.md, Data → Sidebar): per Data
 * Source its schemas, their tables with row estimates and git letters, and a functions group.
 */
import type { DataSource, SchemaTree, TableSummary } from "@polaris/protocol";
import type { TableChange } from "../data/api.ts";
import { isLocked } from "./source.ts";

type Schema = SchemaTree["schemas"][number];

/** A source's schema tree as the sidebar holds it while it loads. */
export type TreeLoad =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: SchemaTree }
  | { readonly status: "failed"; readonly message: string };

export type TreeRow =
  | {
      readonly kind: "source";
      readonly key: string;
      readonly source: DataSource;
      readonly open: boolean;
      /** False for a locked or unreachable source: there's nothing to show under it. */
      readonly expandable: boolean;
    }
  | { readonly kind: "note"; readonly key: string; readonly text: string }
  | {
      readonly kind: "schema";
      readonly key: string;
      readonly name: string;
      readonly open: boolean;
      readonly count: number;
    }
  | {
      readonly kind: "table";
      readonly key: string;
      readonly source: string;
      /** The name a Table tab and `data.describe` take: schema-qualified past one schema. */
      readonly table: string;
      readonly summary: TableSummary;
      readonly view: boolean;
      readonly change: TableChange["change"] | null;
    }
  | {
      readonly kind: "functions";
      readonly key: string;
      readonly open: boolean;
      readonly count: number;
    }
  | { readonly kind: "function"; readonly key: string; readonly name: string };

export interface TreeInput {
  readonly sources: ReadonlyArray<DataSource>;
  readonly trees: ReadonlyMap<string, TreeLoad>;
  readonly changes: ReadonlyArray<TableChange>;
  /** Rows the user opened or closed; the rest take their defaults (`defaultOpen`). */
  readonly toggled: ReadonlyMap<string, boolean>;
}

const join = (...parts: ReadonlyArray<string>) => parts.join("\u0000");

export const sourceKey = (source: string) => join("source", source);

const expandable = (source: DataSource) => source.reachable && !isLocked(source);

/** The first source the user can browse starts open; schemas start open, functions closed. */
const defaultOpen = (kind: TreeRow["kind"], key: string, firstOpen: string | null) => {
  if (kind === "source") return key === firstOpen;

  return kind === "schema";
};

const isOpen = (input: TreeInput, kind: TreeRow["kind"], key: string, firstOpen: string | null) =>
  input.toggled.get(key) ?? defaultOpen(kind, key, firstOpen);

/** Why a source has no children: locked, unreachable, or its schema read failed. */
const noteFor = (source: DataSource, load: TreeLoad | undefined): string | null => {
  if (isLocked(source))
    return source.access === "denied"
      ? "You denied agents this data source."
      : "Agents can't reach it until you approve it.";

  if (!source.reachable)
    return `Can't reach ${source.host}:${source.port}${source.error === undefined ? "" : ` · ${source.error}`}`;

  if (load?.status === "failed") return `Couldn't read its schema · ${load.message}`;

  return load?.status === "loading" ? "Reading schema…" : null;
};

const tableRows = (
  input: TreeInput,
  source: string,
  schema: Schema,
  qualify: boolean
): ReadonlyArray<TreeRow> => {
  const row = (summary: TableSummary, view: boolean): TreeRow => {
    const change = input.changes.find(
      (c) => c.source === source && c.schema === schema.name && c.table === summary.name
    );

    return {
      kind: "table",
      key: join("table", source, schema.name, summary.name),
      source,
      table: qualify ? `${schema.name}.${summary.name}` : summary.name,
      summary,
      view,
      change: change?.change ?? null,
    };
  };

  return [...schema.tables.map((t) => row(t, false)), ...schema.views.map((v) => row(v, true))];
};

const functionRows = (input: TreeInput, source: string, schema: Schema): ReadonlyArray<TreeRow> => {
  if (schema.functions.length === 0) return [];
  const key = join("functions", source, schema.name);
  const open = isOpen(input, "functions", key, null);
  const group: TreeRow = { kind: "functions", key, open, count: schema.functions.length };

  if (!open) return [group];

  return [
    group,
    ...schema.functions.map((name, i): TreeRow => ({
      kind: "function",
      key: join(key, String(i)),
      name,
    })),
  ];
};

const schemaRows = (input: TreeInput, source: string, tree: SchemaTree): ReadonlyArray<TreeRow> => {
  const qualify = tree.schemas.length > 1;

  const rows = tree.schemas.flatMap((schema): ReadonlyArray<TreeRow> => {
    const key = join("schema", source, schema.name);
    const open = isOpen(input, "schema", key, null);
    const count = schema.tables.length + schema.views.length;
    const head: TreeRow = { kind: "schema", key, name: schema.name, open, count };

    if (!open) return [head];

    return [
      head,
      ...tableRows(input, source, schema, qualify),
      ...functionRows(input, source, schema),
    ];
  });

  if (tree.truncatedTables === 0) return rows;

  const more = `${tree.truncatedTables} more tables not shown`;

  return [...rows, { kind: "note", key: join("more", source), text: more }];
};

/** The tree, flattened in display order. */
export const treeRows = (input: TreeInput): ReadonlyArray<TreeRow> => {
  const first = input.sources.find(expandable);
  const firstOpen = first === undefined ? null : sourceKey(first.name);

  return input.sources.flatMap((source): ReadonlyArray<TreeRow> => {
    const key = sourceKey(source.name);
    const canOpen = expandable(source);
    const open = canOpen && isOpen(input, "source", key, firstOpen);
    const head: TreeRow = { kind: "source", key, source, open, expandable: canOpen };
    const load = open ? input.trees.get(source.name) : undefined;
    const note = canOpen && !open ? null : noteFor(source, load ?? { status: "loading" });

    const noteRow: ReadonlyArray<TreeRow> =
      note === null ? [] : [{ kind: "note", key: join("note", source.name), text: note }];

    if (load?.status !== "ready") return [head, ...noteRow];

    return [head, ...schemaRows(input, source.name, load.value)];
  });
};

/** The sources whose schema the open tree needs read. */
export const openSources = (input: Omit<TreeInput, "trees">): ReadonlyArray<string> => {
  const first = input.sources.find(expandable);
  const firstOpen = first === undefined ? null : sourceKey(first.name);

  return input.sources
    .filter(
      (s) =>
        expandable(s) &&
        isOpen({ ...input, trees: new Map() }, "source", sourceKey(s.name), firstOpen)
    )
    .map((s) => s.name);
};
