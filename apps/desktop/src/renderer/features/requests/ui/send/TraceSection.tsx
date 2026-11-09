/**
 * TRACE (DESIGN.md, Requests → Send pane): the send's trace as a mini waterfall rooted at
 * "send · polaris", in Traces' service hues with error spans `critical`, and "Open in Traces ⌘5".
 * A row opens the trace at its span.
 */
import type { TraceDetail } from "@polaris/protocol";
import { cn } from "@polaris/ui";
import type { ReactNode } from "react";
import { commandShortcut } from "../../../../../shared/keymap.ts";
import type { Loaded } from "../../../traces/data/hooks.tsx";
import {
  durationLabel,
  ERROR_HUE,
  serviceHue,
  shortHex,
  type WaterfallRow,
} from "../../../traces/model/waterfall/index.ts";
import { KICKER, Pill } from "../../../traces/ui/span/parts.tsx";
import type { RequestsSessionKey } from "../../model/session.ts";
import { type SendWaterfall, sendWaterfall } from "./model.ts";
import { NoSpansSlot } from "./states.tsx";

/** Past this many rows the rest are Traces' to show. */
export const MINI_ROWS = 12;

const INDENT = 12;

const pct = (n: number) => `${(n * 100).toFixed(3)}%`;

const Row = ({
  row,
  view,
  onOpen,
}: {
  readonly row: WaterfallRow;
  readonly view: SendWaterfall;
  readonly onOpen: (spanId: string) => void;
}) => {
  const { node } = row;
  const hue = node.error ? ERROR_HUE : serviceHue(view.hues.get(node.service));
  const span = Math.max(view.to - view.from, 1e-6);
  const left = (node.start - view.from) / span;
  const width = Math.max((node.end - node.start) / span, 0.004);
  const first = node.spans[0]?.span.id ?? node.key;

  return (
    <button
      type="button"
      onClick={() => onOpen(first)}
      title={`${node.name} · ${node.service}`}
      data-testid="send-trace-row"
      data-error={node.error ? "" : undefined}
      className="hover:bg-fill-hover focus-visible:ring-starlight px-panel grid h-[22px] w-full cursor-default grid-cols-[minmax(0,44%)_minmax(0,1fr)] items-center gap-2 text-left outline-none focus-visible:ring-2"
    >
      <span
        className="flex min-w-0 items-center gap-[5px]"
        style={{ paddingLeft: row.depth * INDENT }}
      >
        <span
          className="size-1.5 shrink-0 rounded-[1.5px]"
          style={{ background: hue }}
          aria-hidden
        />
        <span
          className={cn(
            "text-caption min-w-0 truncate",
            node.error ? "text-severity-critical-text" : "text-text-default"
          )}
        >
          {node.name}
        </span>
        {node.fold ? (
          <span className="text-micro text-text-subtle shrink-0 font-mono">{`×${node.spans.length}`}</span>
        ) : null}
        {node.newService ? (
          <span className="text-micro text-text-subtle shrink-0 font-mono">{`· ${node.service}`}</span>
        ) : null}
      </span>
      <span className="relative h-full">
        <span className="absolute inset-y-0 right-12 left-0">
          <span
            className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-[2px]"
            style={{
              left: pct(left),
              width: pct(width),
              background: `color-mix(in srgb, ${hue} 65%, transparent)`,
            }}
          />
        </span>
        <span className="text-micro text-text-subtle absolute inset-y-0 right-0 flex w-11 items-center justify-end font-mono">
          {durationLabel(node.duration)}
        </span>
      </span>
    </button>
  );
};

const Caption = ({ children }: { readonly children: string }) => (
  <p className="text-caption text-text-faint px-panel py-1.5" data-testid="send-trace-note">
    {children}
  </p>
);

const Body = ({
  view,
  onOpen,
}: {
  readonly view: SendWaterfall;
  readonly onOpen: (spanId: string | null) => void;
}) => {
  const shown = view.rows.slice(0, MINI_ROWS);
  const more = view.rows.length - shown.length;

  return (
    <div role="list" aria-label="Spans" data-testid="send-trace">
      {shown.map((row) => (
        <div role="listitem" key={row.node.key}>
          <Row row={row} view={view} onOpen={onOpen} />
        </div>
      ))}
      {more > 0 ? (
        <Caption>{`${more} more ${more === 1 ? "row" : "rows"} in Traces`}</Caption>
      ) : null}
    </div>
  );
};

const spansLabel = (n: number) => `${n} ${n === 1 ? "span" : "spans"}`;

const Shown = ({
  trace,
  onOpen,
  noSpans,
}: {
  readonly trace: Loaded<TraceDetail>;
  readonly onOpen: (spanId: string | null) => void;
  readonly noSpans: ReactNode;
}) => {
  if (trace.status === "loading") return <Caption>Reading the trace</Caption>;

  if (trace.status === "failed") return <Caption>{trace.error.message}</Caption>;
  const view = sendWaterfall(trace.value);

  if (view === null) return <Caption>No spans yet</Caption>;

  return (
    <>
      <Body view={view} onOpen={onOpen} />
      {view.spans === 1 ? noSpans : null}
    </>
  );
};

export const TraceSection = ({
  at,
  traceId,
  trace,
  answered,
  onOpen,
}: {
  readonly at: RequestsSessionKey;
  readonly traceId: string;
  readonly trace: Loaded<TraceDetail>;
  readonly answered: boolean;
  /** Opens the trace in Traces, at a span when one is named. */
  readonly onOpen: (spanId: string | null) => void;
}) => (
  <section aria-label="Trace" className="border-hairline shrink-0 border-t pb-2">
    <div className="px-panel flex items-center gap-2 pt-3 pb-1.5">
      <h3 className={cn(KICKER, "text-text-subtle")}>Trace</h3>
      <span
        className="text-caption text-text-faint min-w-0 flex-1 truncate font-mono"
        title={traceId}
      >
        {trace.status === "ready"
          ? `${spansLabel(trace.value.spans.length)} · ${shortHex(traceId)}`
          : shortHex(traceId)}
      </span>
      <Pill
        onClick={() => onOpen(null)}
        hint={commandShortcut("view.traces")}
        title="Open this trace in Traces"
        testId="send-open-traces"
      >
        Open in Traces
      </Pill>
    </div>
    <Shown trace={trace} onOpen={onOpen} noSpans={answered ? <NoSpansSlot at={at} /> : null} />
  </section>
);
