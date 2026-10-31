/**
 * The selected Data Source's catalog for one SQL tab: its schema tree, then the detail (keys,
 * nullability) of each table the query names, read once per source while the app runs.
 */
import { SchemaTree, TableDetail } from "@polaris/protocol";
import { useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { IpcError } from "../../../../shared/api.ts";
import type { DataApi } from "../data/api.ts";
import { useDataApi, useDescribe } from "../data/hooks.tsx";
import type { DataSessionKey } from "../model/store.ts";
import { type Catalog, type CatalogTable, catalogDetailKey, catalogOf } from "./catalog.ts";

/** Table names the query mentions as whole words, whose detail hasn't been read. */
export const namedTables = (text: string, catalog: Catalog): ReadonlyArray<CatalogTable> => {
  const words = new Set(text.toLowerCase().match(/[\w$]+/g) ?? []);

  return catalog.tables.filter(
    (t) => words.has(t.name.toLowerCase()) && t.columns.every((c) => c.nullable === null)
  );
};

/** At most this many tables are read per change, so a pasted query can't fan out. */
const READS_PER_CHANGE = 8;

const READ_DELAY_MS = 300;

type Details = ReadonlyMap<string, TableDetail>;

/** Read details by source (`sourceKey`). */
const detailStore = createStore<Readonly<Record<string, Details>>>(() => ({}));

const reading = new Set<string>();

const NONE: Details = new Map();

const sourceKey = (hostKey: string, sessionId: string, source: string) =>
  `${hostKey}\u0000${sessionId}\u0000${source}`;

const readDetail = async (api: DataApi, at: DataSessionKey, source: string, table: string) => {
  const key = sourceKey(at.hostKey, at.sessionId, source);
  const flight = `${key}\u0000${table}`;

  if (reading.has(flight)) return;
  reading.add(flight);
  const result = await api.describe(at, { source, table });

  reading.delete(flight);

  if (!result.ok || !(result.value instanceof TableDetail)) return;
  const detail = result.value;

  detailStore.setState((all) => {
    const known = new Map(all[key] ?? NONE);

    known.set(catalogDetailKey(detail.schema, detail.name), detail);

    return { ...all, [key]: known };
  });
};

export type CatalogState =
  | { readonly status: "none" | "loading" }
  | { readonly status: "failed"; readonly error: IpcError }
  | { readonly status: "ready"; readonly catalog: Catalog; readonly tree: SchemaTree };

export const useCatalog = (at: DataSessionKey, source: string, text: string): CatalogState => {
  const api = useDataApi();
  const { hostKey, sessionId } = at;
  const described = useDescribe(at, source === "" ? null : { source });

  const tree =
    described.status === "ready" && described.value instanceof SchemaTree ? described.value : null;

  const known = useStore(detailStore, (all) => all[sourceKey(hostKey, sessionId, source)] ?? NONE);
  const catalog = useMemo(() => (tree === null ? null : catalogOf(tree, known)), [tree, known]);

  useEffect(() => {
    if (catalog === null) return undefined;
    const wanted = namedTables(text, catalog).slice(0, READS_PER_CHANGE);

    if (wanted.length === 0) return undefined;

    const timer = setTimeout(() => {
      for (const table of wanted) void readDetail(api, { hostKey, sessionId }, source, table.name);
    }, READ_DELAY_MS);

    return () => clearTimeout(timer);
  }, [api, hostKey, sessionId, source, catalog, text]);

  if (source === "") return { status: "none" };

  if (described.status === "failed") return { status: "failed", error: described.error };

  return catalog === null || tree === null
    ? { status: "loading" }
    : { status: "ready", catalog, tree };
};
