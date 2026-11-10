/**
 * A Table tab's load as one Self-Trace Span (ENG-745): from its `data.describe` to the first page
 * of rows. A load that ends without asking for rows says why, so a Span shows where it stopped.
 */
import type { TraceContext } from "@polaris/protocol";
import { type RefObject, useCallback, useEffect, useRef } from "react";
import { type RendererSpan, selfTraces } from "../../../selfTraces/index.ts";
import type { Loaded } from "../../data/hooks.tsx";
import type { Pages } from "./usePages.ts";

export const TABLE_LOAD_SPAN = "data.table.load";

export const NO_DETAIL =
  "data.describe answered without the table's detail, so no rows were asked for";

export interface LoadTarget {
  readonly source: string;
  readonly table: string;
  readonly engine: string;
}

export interface LoadState {
  readonly described: Loaded<unknown>["status"];
  readonly describeError: string | null;
  /** The describe answered with the table's detail. */
  readonly detail: boolean;
  /** Why the filter can't run, which keeps the rows from being asked for. */
  readonly problem: string | null;
  readonly pages: Pick<Pages, "status" | "fetching" | "rows" | "error">;
}

export type LoadEnd =
  | { readonly outcome: "rows"; readonly rows: number }
  | { readonly outcome: "filter-problem" }
  | {
      readonly outcome: "describe-failed" | "no-detail" | "rows-failed";
      readonly failure: string;
    };

/** How the load ended, or null while it's under way; `asked` once its first page was asked for. */
export const loadEnd = (state: LoadState, asked: boolean): LoadEnd | null => {
  if (state.described === "loading") return null;

  if (state.described === "failed")
    return { outcome: "describe-failed", failure: state.describeError ?? "The describe failed" };

  if (!state.detail) return { outcome: "no-detail", failure: NO_DETAIL };

  if (state.problem !== null) return { outcome: "filter-problem" };

  if (!asked) return null;

  if (state.pages.status === "failed")
    return { outcome: "rows-failed", failure: state.pages.error?.message ?? "The query failed" };

  return state.pages.status === "ready" && !state.pages.fetching
    ? { outcome: "rows", rows: state.pages.rows.length }
    : null;
};

interface OpenLoad {
  readonly span: RendererSpan;
  /** This target's describe was seen in flight, so a ready result is this target's. */
  described: boolean;
  /** This target's first page was seen in flight. */
  asked: boolean;
}

export interface LoadSpan {
  readonly target: LoadTarget | null;
  readonly open: RefObject<OpenLoad | null>;
  /** The open load's trace, for its describe and first page; undefined once it ends. */
  readonly trace: () => TraceContext | undefined;
}

/**
 * One Span per target while Self-Traces are on. Call it before the describe's hook: effects run
 * in order, so the Span is open when the describe is sent and can parent the Daemon's Spans.
 */
export const useLoadSpan = (target: LoadTarget | null): LoadSpan => {
  const open = useRef<OpenLoad | null>(null);
  const source = target?.source;
  const table = target?.table;
  const engine = target?.engine;

  useEffect(() => {
    if (source === undefined || table === undefined || engine === undefined) return;

    const span = selfTraces()?.start(TABLE_LOAD_SPAN, {
      "polaris.data.source": source,
      "polaris.data.table": table,
      "polaris.data.engine": engine,
    });

    open.current = span == null ? null : { span, described: false, asked: false };

    return () => {
      open.current?.span.end(undefined, { "polaris.data.outcome": "closed" });
      open.current = null;
    };
  }, [source, table, engine]);

  const trace = useCallback(() => open.current?.span.trace, []);

  return { target, open, trace };
};

/** Ends the load's Span when its state says how it ended; effects run on state changes. */
export const useLoadTrace = ({ target, open }: LoadSpan, state: LoadState) => {
  const source = target?.source;
  const table = target?.table;
  const engine = target?.engine;
  const { described, describeError, detail, problem, pages } = state;

  // The target is a dependency so this also runs right after a new Span starts.
  useEffect(() => {
    const load = open.current;

    if (load === null) return;

    if (described === "loading") load.described = true;

    if (pages.fetching && load.described && detail) load.asked = true;

    if (!load.described) return;
    const end = loadEnd({ described, describeError, detail, problem, pages }, load.asked);

    if (end === null) return;
    open.current = null;
    load.span.end("failure" in end ? end.failure : undefined, {
      "polaris.data.outcome": end.outcome,
      ...(end.outcome === "rows" ? { "polaris.data.rows": end.rows } : undefined),
    });
  }, [open, source, table, engine, described, describeError, detail, problem, pages]);
};
