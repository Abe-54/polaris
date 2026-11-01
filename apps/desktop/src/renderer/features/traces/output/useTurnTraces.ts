/**
 * The Turn's traces for Output: one watch per Turn shown, filtered to that Turn, so newer traffic
 * in the checkout never pushes them out; and one of the newest traces for the earlier runs they
 * compare with. Null on a Daemon without the traces capability, where nothing is watched, and
 * until every watch has answered.
 */
import {
  type SessionId,
  TRACES_CAPABILITY,
  type TraceFilter,
  type TracesSnapshot,
  type TraceSummary,
  TurnId,
} from "@polaris/protocol";
import { useEffect, useMemo, useState } from "react";
import { hasCapability, useHost } from "../../session/hooks.ts";
import { useTracesApi } from "../data/hooks.tsx";
import { type TurnTraces, turnTraces } from "./model.ts";

/** The most `traces.watch` returns. */
const MOST = 200;

/** The earlier runs a Turn's traces compare with ("was 122 ms"). */
const NEWEST: TraceFilter = { limit: MOST };

const COMPARE = "newest";

interface Seen {
  /** The watches' key: the session and the Turns, so another's answers never show. */
  readonly key: string;
  readonly snapshots: ReadonlyMap<string, TracesSnapshot>;
}

/** Each Turn's traces and the newest ones, once, by id. */
const merged = (snapshots: ReadonlyMap<string, TracesSnapshot>): ReadonlyArray<TraceSummary> => {
  const byId = new Map<string, TraceSummary>();

  for (const snapshot of snapshots.values()) for (const t of snapshot.traces) byId.set(t.id, t);

  return [...byId.values()];
};

/** What the Turns' filtered watches count, which can exceed what one of them lists. */
const counted = (snapshots: ReadonlyMap<string, TracesSnapshot>) =>
  [...snapshots].reduce((sum, [name, s]) => (name === COMPARE ? sum : sum + s.total), 0);

export const useTurnTraces = (
  hostKey: string,
  sessionId: SessionId,
  /** The Turns Output shows; empty before the first Turn. */
  turnIds: ReadonlyArray<string>
): TurnTraces | null => {
  const api = useTracesApi();
  const host = useHost(hostKey);
  const supported = hasCapability(host, TRACES_CAPABILITY);
  // The main process ends each watch with the connection; a new epoch watches again.
  const epoch = host?.status.epoch ?? 0;
  const turns = turnIds.join("\u0000");
  const watchKey = `${hostKey}\u0000${sessionId}\u0001${turns}`;
  const [seen, setSeen] = useState<Seen | null>(null);

  useEffect(() => {
    if (!supported || turns === "") return undefined;

    const filters: ReadonlyArray<readonly [string, TraceFilter]> = [
      [COMPARE, NEWEST],
      ...turns.split("\u0000").map((id) => [id, { turn: TurnId.make(id), limit: MOST }] as const),
    ];

    const stops = filters.map(([name, filter]) =>
      api.watch({ hostKey, sessionId }, filter, {
        next: (snapshot) =>
          setSeen((last) => {
            const snapshots = new Map(last?.key === watchKey ? last.snapshots : []);

            snapshots.set(name, snapshot);

            return { key: watchKey, snapshots };
          }),
      })
    );

    return () => {
      for (const stop of stops) stop();
    };
  }, [api, supported, hostKey, sessionId, turns, watchKey, epoch]);

  const wanted = turns === "" ? 0 : turns.split("\u0000").length + 1;
  const snapshots = supported && seen?.key === watchKey ? seen.snapshots : null;

  return useMemo(() => {
    if (snapshots === null || snapshots.size < wanted || turns === "") return null;
    const traces = turnTraces(merged(snapshots), new Set(turns.split("\u0000")));

    return { ...traces, total: Math.max(traces.total, counted(snapshots)) };
  }, [snapshots, wanted, turns]);
};
