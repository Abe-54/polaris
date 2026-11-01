/**
 * The selected Data Source's catalog for one SQL tab: its schema tree, then the detail (keys,
 * nullability) of each table the query names, read once per tree and dropped with it.
 */
import { SchemaTree, TableDetail } from "@polaris/protocol";
import { useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { IpcError } from "../../../../shared/api.ts";
import type { DataApi } from "../data/api.ts";
import { useDataApi, useDescribe, useQueryLog } from "../data/hooks.tsx";
import { schemaChange } from "../model/queryLog.ts";
import { useSourcesGeneration } from "../model/refresh.ts";
import type { DataSessionKey } from "../model/store.ts";
import { type Catalog, type CatalogTable, catalogDetailKey, catalogOf } from "./catalog.ts";

/** Table names the query mentions as whole words that haven't been asked about this tree. */
export const namedTables = (
  text: string,
  catalog: Catalog,
  asked: ReadonlySet<string> = new Set()
): ReadonlyArray<CatalogTable> => {
  const words = new Set(text.toLowerCase().match(/[\w$]+/g) ?? []);
  const wanted = new Map<string, CatalogTable>();

  for (const t of catalog.tables) {
    const name = t.name.toLowerCase();

    // describe takes a name, not a schema: one read per name, whichever schema answers.
    if (words.has(name) && !asked.has(name) && t.columns.every((c) => c.nullable === null))
      wanted.set(name, wanted.get(name) ?? t);
  }

  return [...wanted.values()];
};

/** At most this many tables are read per change, so a pasted query can't fan out. */
const READS_PER_CHANGE = 8;

const READ_DELAY_MS = 300;

/** One source's details, for the tree loaded at `loadedAt`; a newer tree starts them over. */
interface Details {
  readonly loadedAt: string;
  readonly details: ReadonlyMap<string, TableDetail>;
  /** Lowercase names already described for this tree, answered or not. */
  readonly asked: ReadonlySet<string>;
}

const detailStore = createStore<Readonly<Record<string, Details>>>(() => ({}));

const sourceKey = (hostKey: string, sessionId: string, source: string) =>
  `${hostKey}\u0000${sessionId}\u0000${source}`;

const forTree = (
  all: Readonly<Record<string, Details>>,
  key: string,
  loadedAt: string
): Details => {
  const known = all[key];

  return known?.loadedAt === loadedAt ? known : { loadedAt, details: new Map(), asked: new Set() };
};

/** Drops details read for an older tree, so a migrated table is read again. */
export const startTree = (key: string, loadedAt: string) =>
  detailStore.setState((all) =>
    all[key]?.loadedAt === loadedAt ? all : { ...all, [key]: forTree(all, key, loadedAt) }
  );

const readDetail = async (
  api: DataApi,
  at: DataSessionKey,
  source: string,
  table: string,
  loadedAt: string
) => {
  const key = sourceKey(at.hostKey, at.sessionId, source);
  const name = table.toLowerCase();

  if (forTree(detailStore.getState(), key, loadedAt).asked.has(name)) return;
  detailStore.setState((all) => {
    const tree = forTree(all, key, loadedAt);

    return { ...all, [key]: { ...tree, asked: new Set([...tree.asked, name]) } };
  });
  const result = await api.describe(at, { source, table });

  if (!result.ok || !(result.value instanceof TableDetail)) return;
  const detail = result.value;

  detailStore.setState((all) => {
    // A tree loaded since this read began has its own details.
    if (all[key]?.loadedAt !== loadedAt) return all;
    const tree = forTree(all, key, loadedAt);
    const details = new Map(tree.details);

    details.set(catalogDetailKey(detail.schema, detail.name), detail);

    return { ...all, [key]: { ...tree, details } };
  });
};

/** Re-reads one SQL tab's schema: Reload, a sources refresh, or DDL in the Query Log. */
const reloads = createStore<Readonly<Record<string, number>>>(() => ({}));

export const reloadSchema = (at: DataSessionKey, source: string) => {
  const key = sourceKey(at.hostKey, at.sessionId, source);

  reloads.setState((all) => ({ ...all, [key]: (all[key] ?? 0) + 1 }));
};

export type CatalogState =
  | { readonly status: "none" | "loading" }
  | { readonly status: "failed"; readonly error: IpcError }
  | { readonly status: "ready"; readonly catalog: Catalog; readonly tree: SchemaTree };

const NO_DETAILS: ReadonlyMap<string, TableDetail> = new Map();

const NO_NAMES: ReadonlySet<string> = new Set();

/** What re-reads the tree: Reload, a sources refresh, or a schema change in the Query Log. */
const useTreeGeneration = (at: DataSessionKey, source: string) => {
  const key = sourceKey(at.hostKey, at.sessionId, source);
  const reloaded = useStore(reloads, (all) => all[key] ?? 0);
  const refreshed = useSourcesGeneration(at);
  const log = useQueryLog(at);
  const changed = log.status === "ready" ? schemaChange(log.value, source) : null;

  return `${reloaded}\u0000${refreshed}\u0000${changed ?? ""}`;
};

export const useCatalog = (at: DataSessionKey, source: string, text: string): CatalogState => {
  const api = useDataApi();
  const { hostKey, sessionId } = at;
  const generation = useTreeGeneration(at, source);
  const described = useDescribe(at, source === "" ? null : { source }, generation);

  const tree =
    described.status === "ready" && described.value instanceof SchemaTree ? described.value : null;

  const key = sourceKey(hostKey, sessionId, source);
  const loadedAt = tree?.loadedAt ?? null;

  const own = useStore(detailStore, (all) =>
    loadedAt !== null && all[key]?.loadedAt === loadedAt ? all[key] : undefined
  );

  const known = own?.details ?? NO_DETAILS;
  const asked = own?.asked ?? NO_NAMES;
  const catalog = useMemo(() => (tree === null ? null : catalogOf(tree, known)), [tree, known]);

  useEffect(() => {
    if (loadedAt !== null) startTree(key, loadedAt);
  }, [key, loadedAt]);

  useEffect(() => {
    if (catalog === null || loadedAt === null) return undefined;
    const wanted = namedTables(text, catalog, asked).slice(0, READS_PER_CHANGE);

    if (wanted.length === 0) return undefined;

    const timer = setTimeout(() => {
      for (const table of wanted)
        void readDetail(api, { hostKey, sessionId }, source, table.name, loadedAt);
    }, READ_DELAY_MS);

    return () => clearTimeout(timer);
  }, [api, hostKey, sessionId, source, catalog, asked, loadedAt, text]);

  if (source === "") return { status: "none" };

  if (described.status === "failed") return { status: "failed", error: described.error };

  return catalog === null || tree === null
    ? { status: "loading" }
    : { status: "ready", catalog, tree };
};
