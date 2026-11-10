/**
 * The Working strip's model (DESIGN.md, Traces → Working strip): the running Turn's traces, and
 * Follow, kept per Agent Session, which opens each new one as it arrives.
 */
import type { SessionId, TraceSummary } from "@polaris/protocol";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { scopedKey, type TracesSessionKey } from "./session.ts";

const store = createStore<Readonly<Record<string, boolean>>>(() => ({}));

export const setFollow = (at: TracesSessionKey, on: boolean) =>
  store.setState((s) => ({ ...s, [scopedKey(at)]: on }));

/** Off until the user turns it on, so a trace being read is never taken away unasked. */
export const useFollow = (at: TracesSessionKey): boolean =>
  useStore(store, (s) => s[scopedKey(at)] ?? false);

export interface RunningTurnTraces {
  /** The Turn's traces among those listed. */
  readonly count: number;
  /** True when the list was cut off, so the Turn may have more than `count`. */
  readonly more: boolean;
  /** The newest by start, which Follow opens. */
  readonly newest: TraceSummary | null;
}

/** The traces of `sessionId`'s Turn `turn` in a snapshot listed newest first. */
export const runningTurnTraces = (
  traces: ReadonlyArray<TraceSummary>,
  total: number,
  sessionId: SessionId,
  turn: number
): RunningTurnTraces => {
  const mine = traces.filter((t) => t.turn?.sessionId === sessionId && t.turn.number === turn);

  return {
    count: mine.length,
    more: mine.length > 0 && mine.length === traces.length && total > traces.length,
    newest: mine[0] ?? null,
  };
};

/** "14 traces", "1 trace", "50+ traces" when the list was cut off. */
export const turnTracesLabel = ({ count, more }: RunningTurnTraces) =>
  `${count}${more ? "+" : ""} ${count === 1 && !more ? "trace" : "traces"}`;
