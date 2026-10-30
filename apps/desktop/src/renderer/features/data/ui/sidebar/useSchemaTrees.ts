/** Reads each open Data Source's schema tree once (`data.describe` without a table) and keeps it. */
import { useEffect, useRef, useState } from "react";
import { useDataApi } from "../../data/hooks.tsx";
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

/** Data mode remounts per Agent Session, so a tree read never outlives the session it was for. */
export const useSchemaTrees = (
  at: DataSessionKey,
  names: ReadonlyArray<string>
): ReadonlyMap<string, TreeLoad> => {
  const api = useDataApi();
  const [trees, setTrees] = useState<ReadonlyMap<string, TreeLoad>>(new Map());
  const asked = useRef(new Set<string>());
  const mounted = useRef(true);
  const { hostKey, sessionId } = at;
  const wanted = names.join("\u0000");

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const fresh = wanted === "" ? [] : wanted.split("\u0000").filter((n) => !asked.current.has(n));

    for (const name of fresh) {
      asked.current.add(name);
      setTrees((m) => new Map(m).set(name, { status: "loading" }));
      void api.describe({ hostKey, sessionId }, { source: name }).then((result) => {
        if (mounted.current) setTrees((m) => new Map(m).set(name, loadOf(result)));
      });
    }
  }, [api, hostKey, sessionId, wanted]);

  return trees;
};
