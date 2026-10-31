/**
 * The map itself (Paper T5), in map coordinates: the caller's dotted line, dashed orthogonal
 * connectors with a light square and a label, and each node's art under its name and kicker.
 * A node is a button; selecting it fills the service panel.
 */
import { cn } from "@polaris/ui";
import { memo } from "react";
import {
  callerWords,
  edgeWords,
  LABEL_ABOVE,
  type MapLayout,
  type MapNode,
  nodeWords,
  type ServiceMap,
} from "../../model/map/index.ts";
import { serviceHue } from "../../model/waterfall/index.ts";
import { KICKER } from "../span/parts.tsx";
import { NodeGlyph } from "./art.tsx";

export const LINK = "color-mix(in oklab, var(--color-text-strong) 26%, transparent)";

const LIGHT_SQUARE = "var(--color-text-default)";

const LABEL_WIDTH = 212;

const dim = (on: boolean) => ({ opacity: on ? 1 : "var(--opacity-dimmed)" });

const Label = ({
  node,
  map,
  x,
  base,
  selected,
  lit,
  onSelect,
}: {
  readonly node: MapNode;
  readonly map: ServiceMap;
  readonly x: number;
  readonly base: number;
  readonly selected: boolean;
  readonly lit: boolean;
  readonly onSelect: (name: string) => void;
}) => (
  <button
    type="button"
    aria-pressed={selected}
    data-testid="map-node"
    data-node={node.name}
    onClick={() => onSelect(node.name)}
    className="focus-visible:ring-starlight rounded-row absolute flex cursor-default flex-col items-center gap-1 pt-1 outline-none focus-visible:ring-2"
    style={{
      left: x - LABEL_WIDTH / 2,
      top: base - LABEL_ABOVE - 4,
      width: LABEL_WIDTH,
      height: LABEL_ABOVE + 8,
      ...dim(lit),
    }}
  >
    <span
      title={node.name}
      className={cn(
        "text-heading-sm max-w-full truncate rounded-full px-2 font-medium",
        selected ? "bg-fill-selected text-text-strong" : "text-text-default"
      )}
    >
      {node.name}
    </span>
    <span className={cn(KICKER, "text-text-subtle max-w-full truncate")}>
      {nodeWords(
        node,
        map.edges.filter((e) => e.to === node.name)
      ).join(" · ")}
      {node.errors > 0 ? (
        <span className="text-severity-critical-text">
          {` · ${node.errors} error${node.errors === 1 ? "" : "s"}`}
        </span>
      ) : null}
    </span>
  </button>
);

export const MapLayer = memo(function MapLayer({
  map,
  layout,
  selected,
  lit,
  onSelect,
}: {
  readonly map: ServiceMap;
  readonly layout: MapLayout;
  readonly selected: string | null;
  /** The services Find spans, Errors only or the Services chip keep; null keeps them all. */
  readonly lit: ReadonlySet<string> | null;
  readonly onSelect: (name: string) => void;
}) {
  const on = (name: string) => lit === null || lit.has(name);

  return (
    <>
      <svg
        width={layout.width}
        height={layout.height}
        className="absolute inset-0 overflow-visible [shape-rendering:crispEdges]"
        aria-hidden
      >
        {layout.caller.paths.map((d) => (
          <path key={d} d={d} style={{ fill: "none", stroke: LINK }} strokeDasharray="1 3" />
        ))}
        {layout.routes.map((r) => (
          <g key={`${r.edge.from}\u0000${r.edge.to}`} style={dim(on(r.edge.from) && on(r.edge.to))}>
            <path d={r.path} style={{ fill: "none", stroke: LINK }} strokeDasharray="2 2" />
            <rect
              x={r.light.x - 1}
              y={r.light.y - 1}
              width={3}
              height={3}
              style={{ fill: LIGHT_SQUARE }}
            />
          </g>
        ))}
        {layout.placed.map((p) => (
          <g key={p.node.name} style={dim(on(p.node.name))}>
            <NodeGlyph
              kind={p.node.kind}
              at={{ x: p.x, y: p.base }}
              light={p.node.hue === null ? null : serviceHue(p.node.hue)}
            />
          </g>
        ))}
      </svg>
      <span
        data-testid="map-caller"
        className={cn(KICKER, "text-text-subtle absolute text-center whitespace-nowrap")}
        style={{ left: layout.caller.at.x - 200, top: layout.caller.at.y, width: 400 }}
      >
        {callerWords(map.caller).join(" · ")}
      </span>
      {layout.routes.map((r) => (
        <span
          key={`${r.edge.from}\u0000${r.edge.to}`}
          data-testid="map-edge"
          className={cn(KICKER, "text-text-subtle absolute whitespace-nowrap")}
          style={{ left: r.label.x, top: r.label.y - 7, ...dim(on(r.edge.from) && on(r.edge.to)) }}
        >
          {edgeWords(r.edge)}
        </span>
      ))}
      {layout.placed.map((p) => (
        <Label
          key={p.node.name}
          node={p.node}
          map={map}
          x={p.x}
          base={p.base}
          selected={selected === p.node.name}
          lit={on(p.node.name)}
          onSelect={onSelect}
        />
      ))}
    </>
  );
});
