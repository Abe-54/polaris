/**
 * The Turn's traces for Output, from one watch of the session's newest traces; null on a Daemon
 * without the traces capability, where nothing is watched, and until the first snapshot.
 */
import {
  type SessionId,
  TRACES_CAPABILITY,
  type TraceFilter,
  type TraceSummary,
} from "@polaris/protocol";
import { useEffect, useMemo, useState } from "react";
import { hasCapability, useHost } from "../../session/hooks.ts";
import { useTracesApi } from "../data/hooks.tsx";
import { type TurnTraces, turnTraces } from "./model.ts";

/** The most `traces.watch` returns: the Turn's traces and the earlier runs they compare with. */
const NEWEST: TraceFilter = { limit: 200 };

interface Seen {
  readonly key: string;
  readonly traces: ReadonlyArray<TraceSummary>;
}

export const useTurnTraces = (
  hostKey: string,
  sessionId: SessionId,
  /** The Turns Output shows; empty before the first Turn. */
  turnIds: ReadonlyArray<string>
): TurnTraces | null => {
  const api = useTracesApi();
  const supported = hasCapability(useHost(hostKey), TRACES_CAPABILITY);
  const watchKey = `${hostKey}\u0000${sessionId}`;
  const [seen, setSeen] = useState<Seen | null>(null);

  useEffect(() => {
    if (!supported) return undefined;

    return api.watch({ hostKey, sessionId }, NEWEST, {
      next: (snapshot) => setSeen({ key: watchKey, traces: snapshot.traces }),
    });
  }, [api, supported, hostKey, sessionId, watchKey]);

  const turns = turnIds.join("\u0000");
  // A snapshot from another session's watch never shows.
  const traces = supported && seen?.key === watchKey ? seen.traces : null;

  return useMemo(
    () =>
      traces === null || turns === "" ? null : turnTraces(traces, new Set(turns.split("\u0000"))),
    [traces, turns]
  );
};
