/**
 * The Service map view (DESIGN.md, Traces → Service map; Paper T5): one trace's services in the
 * Hosts card's art on a well you drag, scroll and double-click, its legend and hints at the foot,
 * and the service panel for the selected service beside it.
 */
import { cn } from "@polaris/ui";
import { useMemo, useState } from "react";
import {
  type Caller,
  mapLayout,
  serviceMap,
  servicePanel,
  type ServiceMap as Map_,
  startedWords,
} from "../../model/map/index.ts";
import type { TraceView } from "../waterfall/useTraceView.ts";
import { labelBox, LINK, MapLayer } from "./MapLayer.tsx";
import { ServicePanel } from "./ServicePanel.tsx";
import { usePanZoom } from "./usePanZoom.ts";

const HINT = "text-text-subtle font-mono text-[11px] leading-[14px]";

const Legend = ({ caller }: { readonly caller: Caller }) => (
  <div className="text-caption text-text-subtle flex items-center gap-4">
    <span className="flex items-center gap-1.5">
      <svg width="18" height="6" aria-hidden>
        <path d="M0 3H18" style={{ stroke: LINK }} strokeDasharray="2 2" />
        <rect x="7.5" y="1.5" width="3" height="3" style={{ fill: "var(--color-text-default)" }} />
      </svg>
      Calls
    </span>
    <span className="flex items-center gap-1.5">
      <svg width="12" height="12" aria-hidden>
        <rect
          x="0.5"
          y="0.5"
          width="11"
          height="11"
          rx="2"
          style={{ fill: "none", stroke: "var(--color-text-subtle)" }}
          strokeDasharray="2 2"
        />
      </svg>
      Inferred from client spans
    </span>
    <span className="flex items-center gap-1.5">
      <svg width="12" height="12" aria-hidden>
        <path d="M6 0V12" style={{ stroke: LINK }} strokeDasharray="1 3" />
      </svg>
      {startedWords(caller)}
    </span>
  </div>
);

const Hints = () => (
  <div className="flex items-center gap-3.5 max-[1180px]:hidden">
    <span className={HINT}>Drag to pan</span>
    <span className={HINT}>Scroll to zoom</span>
    <span className={HINT}>Double-click to fit</span>
  </div>
);

/** The services Find spans, Errors only, the Services chip or a hovered service keep lit. */
const useLit = ({ focus, hovered, table }: TraceView, map: Map_): ReadonlySet<string> | null =>
  useMemo(() => {
    const narrowed = focus.find.trim() !== "" || focus.errorsOnly || focus.service !== null;

    if (!narrowed && hovered === null) return null;
    const names = narrowed ? table.map((n) => n.service) : map.nodes.map((n) => n.name);
    const kept = new Set(hovered === null ? names : names.filter((n) => n === hovered));

    for (const e of map.edges) if (e.inferred && kept.has(e.from)) kept.add(e.to);

    return kept;
  }, [focus, hovered, table, map]);

export const ServiceMap = ({
  trace,
  onOpenSpan,
}: {
  readonly trace: TraceView;
  readonly onOpenSpan: (spanId: string) => void;
}) => {
  const map = useMemo(() => serviceMap(trace.times), [trace.times]);
  const layout = useMemo(() => mapLayout(map), [map]);
  const { width, height } = layout;
  // Keyed on the numbers: a growing trace's new layout mustn't re-open the view.
  const size = useMemo(() => ({ width, height }), [width, height]);

  const [selected, setSelected] = useState<string | null>(
    () => map.caller.roots.keys().next().value ?? map.nodes[0]?.name ?? null
  );

  const panel = useMemo(
    () => (selected === null ? null : servicePanel(map, selected)),
    [map, selected]
  );

  const lit = useLit(trace, map);
  const { canvas, layer, handlers, wasDrag, reveal } = usePanZoom(size);
  const at = useMemo(() => new Map(layout.placed.map((p) => [p.node.name, p])), [layout]);

  return (
    <div className="flex min-h-0 flex-1" data-testid="service-map">
      <div
        ref={canvas}
        role="group"
        aria-label="Service map. Drag to pan, scroll or press + and − to zoom, 0 or double-click to fit."
        tabIndex={0}
        {...handlers}
        className={cn(
          "bg-well ring-hairline focus-visible:ring-starlight relative mr-3 mb-3 ml-4 min-w-0 flex-1 cursor-grab touch-none overflow-hidden rounded-row ring-1 outline-none select-none ring-inset focus-visible:ring-2 active:cursor-grabbing"
        )}
      >
        <div
          ref={layer}
          data-testid="service-map-layer"
          className="absolute top-0 left-0 origin-top-left"
          style={{ width: layout.width, height: layout.height }}
        >
          <MapLayer
            map={map}
            layout={layout}
            selected={selected}
            lit={lit}
            onSelect={(name, byPointer) => {
              if (!byPointer || !wasDrag()) setSelected(name);
            }}
            onFocus={(name) => {
              const p = at.get(name);

              if (p !== undefined) reveal(labelBox(p.x, p.base));
            }}
          />
        </div>
        {/* The foot sits on the well, so the map passes under it. */}
        <div className="bg-well rounded-b-row pointer-events-none absolute inset-x-px bottom-px flex h-11 items-center justify-between px-4">
          <Legend caller={map.caller} />
          <Hints />
        </div>
      </div>
      {panel === null ? null : (
        <ServicePanel
          model={panel}
          onSelect={setSelected}
          onClose={() => setSelected(null)}
          onOpen={onOpenSpan}
        />
      )}
    </div>
  );
};
