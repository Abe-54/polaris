/**
 * The service panel (DESIGN.md, Traces → Service map; Paper T5): Requests, Request time, Spans
 * and Errors; the services it calls with their totals and any N+1; who called it; and its
 * slowest requests. Only this trace's spans, computed here rather than asked of the Daemon.
 */
import type { TimedSpan } from "../waterfall/trace.ts";
import { formatDuration } from "../format.ts";
import type { Caller, MapEdge, MapNode, NodeKind, ServiceMap } from "./graph.ts";

/**
 * One span, or one served request, making this many calls to the same service is an N+1, and the
 * panel says so. A test runner's root isn't a served request, so its tests aren't counted together.
 */
export const N_PLUS_ONE_AT = 10;

/** Slowest requests listed. */
const SLOWEST = 5;

export interface PanelCall {
  readonly name: string;
  readonly kind: NodeKind;
  readonly hue: number | null;
  readonly calls: number;
  readonly ms: number;
  /** Its total against the busiest callee's, for the bar. */
  readonly share: number;
  readonly nPlusOne: boolean;
}

export interface PanelCaller {
  readonly name: string;
  readonly kind: NodeKind;
  readonly hue: number | null;
  readonly calls: number;
}

export interface ServicePanelModel {
  readonly node: MapNode;
  readonly calls: ReadonlyArray<PanelCall>;
  /** A line for each N+1 among `calls`. */
  readonly nPlusOne: ReadonlyArray<string>;
  readonly calledBy: ReadonlyArray<PanelCaller>;
  /** The trace's caller, when it started this service's root spans. */
  readonly startedBy: (Caller & { readonly spans: number }) | null;
  readonly slowest: ReadonlyArray<TimedSpan>;
}

export const isNPlusOne = (edge: MapEdge) => edge.repeated >= N_PLUS_ONE_AT;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "214 calls to fx-rates in one request: 3 ms each, 640 ms in all." */
export const nPlusOneLine = (edge: MapEdge): string => {
  const where =
    edge.requests === 1
      ? "in one request"
      : `in ${plural(edge.requests, "request")}, up to ${edge.perRequest} in one`;

  return `${edge.calls} calls to ${edge.to} ${where}: ${formatDuration(edge.ms / edge.calls)} each, ${formatDuration(edge.ms)} in all.`;
};

export const servicePanel = (map: ServiceMap, name: string): ServicePanelModel | null => {
  const node = map.nodes.find((n) => n.name === name);

  if (node === undefined) return null;
  const byName = new Map(map.nodes.map((n) => [n.name, n]));
  const out = map.edges.filter((e) => e.from === name).toSorted((a, b) => b.ms - a.ms);
  const busiest = Math.max(0, ...out.map((e) => e.ms));
  const roots = map.caller.roots.get(name);

  return {
    node,
    calls: out.map((e) => ({
      name: e.to,
      kind: byName.get(e.to)?.kind ?? "service",
      hue: byName.get(e.to)?.hue ?? null,
      calls: e.calls,
      ms: e.ms,
      share: busiest === 0 ? 0 : e.ms / busiest,
      nPlusOne: isNPlusOne(e),
    })),
    nPlusOne: out.filter(isNPlusOne).map(nPlusOneLine),
    calledBy: map.edges
      .filter((e) => e.to === name)
      .toSorted((a, b) => b.calls - a.calls)
      .map((e) => ({
        name: e.from,
        kind: byName.get(e.from)?.kind ?? "service",
        hue: byName.get(e.from)?.hue ?? null,
        calls: e.calls,
      })),
    startedBy: roots === undefined ? null : { ...map.caller, spans: roots },
    slowest: node.requests.slice(0, SLOWEST),
  };
};
