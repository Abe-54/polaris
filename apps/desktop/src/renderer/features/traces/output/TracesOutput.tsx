/**
 * Output's Traces tab for the Turn shown (DESIGN.md, Traces → In Orchestrate; Paper T3): failing
 * traces as cards, then the slowest with their previous duration, the rest folded. Each opens in
 * Traces (⌘5); the caller shows the tab only while the Turn has traces.
 */
import type { SessionId, TraceSummary } from "@polaris/protocol";
import { cn } from "@polaris/ui";
import { useState } from "react";
import { useShellActions } from "../../../shell/hooks.ts";
import { menuShortcut } from "../../../shell/menu/index.ts";
import { useOpenInEditor } from "../../editor-links/index.ts";
import { plural } from "../../session/model/format.ts";
import { useTrace } from "../data/hooks.tsx";
import { formatDuration } from "../model/format.ts";
import type { TracesSessionKey } from "../model/session.ts";
import { locationLabel } from "../model/span/code.ts";
import { selectSpan, selectTrace } from "../model/store.ts";
import { KICKER, Pill } from "../ui/span/parts.tsx";
import { foldedLine, LISTED, type TraceRow, traceFailure, type TurnTraces } from "./model.ts";

export interface TracesOutputProps {
  readonly hostKey: string;
  readonly sessionId: SessionId;
  readonly traces: TurnTraces;
  readonly turnNumber: number;
}

/** Opens the trace in Traces (⌘5), with `spanId` selected when given. */
const useOpenTrace = (at: TracesSessionKey) => {
  const actions = useShellActions();

  return (traceId: string, spanId: string | null = null) => {
    selectTrace(at, traceId);

    if (spanId !== null) selectSpan(at, spanId);
    actions.selectSession(at);
    actions.setMode("traces");
  };
};

const FailureCard = ({
  at,
  trace,
  onOpen,
}: {
  readonly at: TracesSessionKey;
  readonly trace: TraceSummary;
  readonly onOpen: (traceId: string, spanId: string | null) => void;
}) => {
  const detail = useTrace(at, trace.id);
  const openInEditor = useOpenInEditor();
  const failure = detail.status === "ready" ? traceFailure(detail.value) : null;
  const checkout = detail.status === "ready" ? detail.value.spans[0]?.polaris : undefined;
  const location = failure?.location ?? null;

  return (
    <article
      className="rounded-card border-severity-critical-text/35 bg-surface-raised flex flex-col gap-2 border p-3.5"
      data-testid="traces-output-failure"
    >
      <header className="text-code-inline flex min-w-0 items-center gap-2 font-mono">
        <span className="bg-severity-critical size-1.5 shrink-0" aria-hidden />
        <span className="text-severity-critical-text min-w-0 flex-1 truncate">{trace.root}</span>
        <span className="text-text-subtle tabular shrink-0">
          {formatDuration(trace.durationMs)} · {plural(trace.spans, "span")}
        </span>
      </header>
      {failure === null ? null : (
        <div className="flex flex-col gap-0.5">
          <p className="text-code-inline text-text-default line-clamp-3 font-mono [overflow-wrap:anywhere] whitespace-pre-line">
            {failure.headline.replace(/\n{2,}/g, "\n")}
          </p>
          <p className="text-code-inline text-text-faint truncate font-mono">
            {location === null ? "" : `at ${locationLabel(location)}`}
            {location !== null && failure.origin !== null ? " · " : ""}
            {failure.origin === null ? "" : `in span ${failure.origin.name}`}
          </p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Pill
          onClick={() => onOpen(trace.id, failure?.origin?.id ?? null)}
          hint={menuShortcut("view.traces")}
          testId="traces-output-open"
        >
          Open in Traces
        </Pill>
        {location === null || checkout === undefined ? null : (
          <Pill
            mono
            hint={undefined}
            title={`Open ${location.path} in the editor`}
            testId="traces-output-code"
            onClick={() =>
              openInEditor({
                hostKey: at.hostKey,
                root: checkout.checkout,
                workspaceId: checkout.workspaceId,
                path: location.path,
                line: location.line,
                column: location.column,
              })
            }
          >
            {locationLabel(location)}
          </Pill>
        )}
      </div>
    </article>
  );
};

const Row = ({ row, onOpen }: { readonly row: TraceRow; readonly onOpen: () => void }) => (
  <li className="border-hairline border-b last:border-b-0">
    <button
      type="button"
      onClick={onOpen}
      title="Open in Traces"
      data-testid="traces-output-row"
      className="hover:bg-fill-hover focus-visible:ring-starlight text-code-inline flex h-(--spacing-row) w-full cursor-default items-center gap-2.5 rounded-[6px] px-2 font-mono outline-none focus-visible:ring-2"
    >
      <span className="bg-text-faint size-1 shrink-0 rounded-full" aria-hidden />
      <span className="text-text-default min-w-0 flex-1 truncate text-left">{row.trace.root}</span>
      {row.was === null ? null : (
        <span className="text-text-faint tabular shrink-0">was {formatDuration(row.was)}</span>
      )}
      <span className="text-text-strong tabular w-[56px] shrink-0 text-right">
        {formatDuration(row.trace.durationMs)}
      </span>
    </button>
  </li>
);

export const TracesOutput = ({ hostKey, sessionId, traces, turnNumber }: TracesOutputProps) => {
  const at = { hostKey, sessionId };
  const open = useOpenTrace(at);
  const [unfolded, setUnfolded] = useState(false);
  const [allFailing, setAllFailing] = useState(false);
  const rows = unfolded ? [...traces.listed, ...traces.folded] : traces.listed;
  // Each card reads its trace in full, so only the first few do until the rest are asked for.
  const cards = allFailing ? traces.failing : traces.failing.slice(0, LISTED);
  const moreFailing = traces.failing.length - cards.length;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
      data-testid="traces-output"
    >
      <div className="flex items-center gap-2">
        <span className={cn(KICKER, "text-text-subtle flex-1")}>
          Turn {turnNumber} · {plural(traces.total, "trace")}
        </span>
        {rows.length > 0 ? (
          <span className="text-caption text-text-faint">Slowest first</span>
        ) : null}
      </div>
      {cards.map((t) => (
        <FailureCard key={t.id} at={at} trace={t} onOpen={open} />
      ))}
      {moreFailing === 0 ? null : (
        <button
          type="button"
          onClick={() => setAllFailing(true)}
          data-testid="traces-output-more-failing"
          className="text-caption text-text-subtle hover:text-text-default focus-visible:ring-starlight rounded-control cursor-default self-start px-2 py-1 outline-none focus-visible:ring-2"
        >
          {moreFailing} more failing
        </button>
      )}
      {rows.length === 0 && traces.folded.length === 0 ? null : (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <Row key={row.trace.id} row={row} onOpen={() => open(row.trace.id)} />
          ))}
          {unfolded || traces.folded.length === 0 ? null : (
            <li>
              <button
                type="button"
                onClick={() => setUnfolded(true)}
                data-testid="traces-output-more"
                className="text-caption text-text-subtle hover:text-text-default focus-visible:ring-starlight flex h-(--spacing-row) w-full cursor-default items-center rounded-[6px] px-2 pl-[22px] outline-none focus-visible:ring-2"
              >
                {foldedLine(traces.folded)}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
};
