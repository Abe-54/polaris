/**
 * Reads each open Data Source's schema tree (`data.describe` without a table). A tree is kept per
 * source target and read again on a sources refresh, when its target changes, and after a failure.
 */
import type { DataSource } from "@polaris/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDataApi } from "../../data/hooks.tsx";
import { useSourcesGeneration } from "../../model/refresh.ts";
import type { DataSessionKey } from "../../model/store.ts";
import type { TreeLoad } from "../../model/tree.ts";

const loadOf = (
  result: Awaited<ReturnType<ReturnType<typeof useDataApi>["describe"]>>
): TreeLoad => {
  if (!result.ok) return { status: "failed", message: result.error.message };

  return "schemas" in result.value
    ? { status: "ready", value: result.value }
    : { status: "failed", message: "The Host answered with a table, not a schema" };
};

/** What a schema read is of: the source and where it points, so a new database is a new read. */
export const schemaTarget = (s: DataSource) =>
  [s.id, s.host, String(s.port), s.database, s.branch?.name ?? ""].join("\u0000");

/** 2s, 4s, 8s, 16s: then a failed read waits for the next refresh (focus, the card opening). */
export const retryDelay = (failures: number) => 1000 * 2 ** failures;

const RETRIES = 4;

interface Entry {
  readonly load: TreeLoad;
  readonly failures: number;
}

interface Reads {
  /** The refresh generation each target was last read at. */
  readonly at: Map<string, number>;
  /** The latest read per target; an older one's answer is dropped. */
  readonly seq: Map<string, number>;
  readonly retries: Map<string, ReturnType<typeof setTimeout>>;
  live: boolean;
}

const useReads = () => {
  const reads = useRef<Reads>({ at: new Map(), seq: new Map(), retries: new Map(), live: true });

  useEffect(() => {
    const current = reads.current;

    current.live = true;

    return () => {
      current.live = false;

      for (const timer of current.retries.values()) clearTimeout(timer);
    };
  }, []);

  return reads.current;
};

export interface SchemaTreeOptions {
  readonly retryMs?: (failures: number) => number;
}

/** Data mode remounts per Agent Session, so a tree read never outlives the session it was for. */
export const useSchemaTrees = (
  at: DataSessionKey,
  sources: ReadonlyArray<DataSource>,
  { retryMs = retryDelay }: SchemaTreeOptions = {}
): ReadonlyMap<string, TreeLoad> => {
  const api = useDataApi();
  const generation = useSourcesGeneration(at);
  const [entries, setEntries] = useState<ReadonlyMap<string, Entry>>(new Map());
  const reads = useReads();
  const { hostKey, sessionId } = at;
  const wanted = sources.map((s) => `${schemaTarget(s)}\u0001${s.name}`).join("\u0002");

  useEffect(() => {
    const set = (target: string, entry: Entry) => setEntries((m) => new Map(m).set(target, entry));

    const read = (target: string, name: string, failures: number) => {
      const seq = (reads.seq.get(target) ?? 0) + 1;

      reads.seq.set(target, seq);
      reads.at.set(target, generation);
      clearTimeout(reads.retries.get(target));
      // A tree being read again stays on screen until the new one lands.
      setEntries((m) =>
        m.get(target)?.load.status === "ready"
          ? m
          : new Map(m).set(target, { load: { status: "loading" }, failures })
      );

      void api.describe({ hostKey, sessionId }, { source: name }).then((result) => {
        if (!reads.live || reads.seq.get(target) !== seq) return;
        const load = loadOf(result);

        if (load.status !== "failed") return set(target, { load, failures: 0 });
        set(target, { load, failures: failures + 1 });

        if (failures + 1 > RETRIES) return;
        const retry = setTimeout(() => read(target, name, failures + 1), retryMs(failures + 1));

        reads.retries.set(target, retry);
      });
    };

    for (const pair of wanted === "" ? [] : wanted.split("\u0002")) {
      const [target = "", name = ""] = pair.split("\u0001");
      const last = reads.at.get(target);

      if (last === undefined || last < generation) read(target, name, 0);
    }
  }, [api, hostKey, sessionId, wanted, generation, reads, retryMs]);

  return useMemo(() => {
    const trees = new Map<string, TreeLoad>();

    for (const pair of wanted === "" ? [] : wanted.split("\u0002")) {
      const [target = "", name = ""] = pair.split("\u0001");
      const entry = entries.get(target);

      if (entry !== undefined) trees.set(name, entry.load);
    }

    return trees;
  }, [entries, wanted]);
};
