/**
 * Where the service map draws each node and connector (Paper T5): the caller on top, services
 * in layers by their distance from it, each layer ordered under its callers, and dashed
 * orthogonal connectors with a light square and a label on each.
 */
import type { MapEdge, MapNode, ServiceMap } from "./graph.ts";

/** A node's lane across; its label is 180px wide inside it. */
export const SLOT = 220;

/** From one layer's bottom vertices to the next's. */
export const PITCH = 214;

/** A node's label starts this far above its art's bottom vertex. */
export const LABEL_ABOVE = 126;

/** Connectors arrive just above the callee's label. */
const ARRIVE_ABOVE = LABEL_ABOVE + 4;

/** The caller's bus drops from its kicker to the top layer. */
const CALLER_BUS = 34;

const CALLER_LINE = 20;

/** The top layer's bottom vertex, under the caller's kicker. */
const FIRST_BASE = 180;

/** How far below a caller its connectors turn across, and the step between callers in a layer. */
const DROP = 36;

const BUS_STEP = 6;

const BUSES = 4;

/** Between connectors arriving at one callee, and between their labels. */
const ENTRY_STEP = 12;

const LABEL_STEP = 16;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface PlacedNode {
  readonly node: MapNode;
  readonly layer: number;
  /** Its lane's centre, and its art's bottom vertex. */
  readonly x: number;
  readonly base: number;
}

export interface Route {
  readonly edge: MapEdge;
  /** An SVG path in map coordinates. */
  readonly path: string;
  readonly light: Point;
  /** Where its label's left edge and middle sit. */
  readonly label: Point;
}

export interface MapLayout {
  readonly width: number;
  readonly height: number;
  readonly placed: ReadonlyArray<PlacedNode>;
  readonly routes: ReadonlyArray<Route>;
  readonly caller: { readonly at: Point; readonly paths: ReadonlyArray<string> };
}

const adjacency = (map: ServiceMap) => {
  const out = new Map<string, Array<string>>();

  for (const e of map.edges) {
    const list = out.get(e.from);

    if (list === undefined) out.set(e.from, [e.to]);
    else list.push(e.to);
  }

  return out;
};

/** Breadth-first from the caller's services; anything it can't reach starts a search of its own. */
const layersOf = (map: ServiceMap): ReadonlyMap<string, number> => {
  const out = adjacency(map);
  const layer = new Map<string, number>();
  const seeds = [...map.caller.roots.keys(), ...map.nodes.map((n) => n.name)];

  for (const seed of seeds) {
    if (layer.has(seed)) continue;
    layer.set(seed, 0);
    const queue = [seed];

    for (let i = 0; i < queue.length; i++) {
      const at = queue[i] ?? seed;
      const next = (layer.get(at) ?? 0) + 1;

      for (const to of out.get(at) ?? [])
        if (!layer.has(to)) {
          layer.set(to, next);
          queue.push(to);
        }
    }
  }

  return layer;
};

const mean = (values: ReadonlyArray<number>) =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

/** Each layer in order of its callers' positions above it, so connectors cross less. */
const place = (map: ServiceMap, layer: ReadonlyMap<string, number>) => {
  const rows = Map.groupBy(map.nodes, (n) => layer.get(n.name) ?? 0);
  const depth = Math.max(0, ...rows.keys()) + 1;
  const widest = Math.max(1, ...[...rows.values()].map((r) => r.length));
  const width = widest * SLOT;
  const order = new Map(map.nodes.map((n, i) => [n.name, i]));
  const x = new Map<string, number>();
  const placed: Array<PlacedNode> = [];

  for (let l = 0; l < depth; l++) {
    const row = (rows.get(l) ?? []).map((n) => {
      const above = map.edges
        .filter((e) => e.to === n.name && (layer.get(e.from) ?? 0) < l)
        .flatMap((e) => x.get(e.from) ?? []);

      return { n, at: mean(above) ?? 0, i: order.get(n.name) ?? 0 };
    });

    row.sort((a, b) => a.at - b.at || a.i - b.i);
    row.forEach(({ n }, i) => {
      const cx = width / 2 + (i - (row.length - 1) / 2) * SLOT;

      x.set(n.name, cx);
      placed.push({ node: n, layer: l, x: cx, base: FIRST_BASE + l * PITCH });
    });
  }

  return { placed, width, depth };
};

/** Where a connector's label sits from the lane it runs in. */
const LABEL_GAP = 9;

/** Room kept right of a side lane for its label ("×214 · HTTP"). */
const LABEL_ROOM = 96;

/** A route back up turns in under the callee's art, above the callee's own bus. */
const TURN_IN = 14;

interface Drawn extends Route {
  /** The lowest and rightmost points it reaches, for the map's size. */
  readonly bottom: number;
  readonly right: number;
}

/**
 * A connector down to the callee's label, or round below into the art of one in its own layer. One
 * up to a higher layer climbs a side lane right of both ends, so it never retraces a call down.
 */
const routesOf = (map: ServiceMap, placed: ReadonlyArray<PlacedNode>): ReadonlyArray<Drawn> => {
  const at = new Map(placed.map((p) => [p.node.name, p]));

  const busOf = new Map(
    [...Map.groupBy(placed, (p) => p.layer).values()].flatMap((row) =>
      row.map((p, i) => [p.node.name, (i % BUSES) * BUS_STEP] as const)
    )
  );

  const into = Map.groupBy(map.edges, (e) => e.to);

  return map.edges.flatMap((edge): ReadonlyArray<Drawn> => {
    const from = at.get(edge.from);
    const to = at.get(edge.to);

    if (from === undefined || to === undefined) return [];

    const arriving = (into.get(edge.to) ?? []).toSorted(
      (a, b) => (at.get(a.from)?.x ?? 0) - (at.get(b.from)?.x ?? 0)
    );

    const j = arriving.indexOf(edge) - (arriving.length - 1) / 2;
    const last = (arriving.length - 1) / 2;
    const bus = from.base + DROP + (busOf.get(edge.from) ?? 0);

    if (to.layer >= from.layer) {
      const ex = to.x + j * ENTRY_STEP;
      const end = to.layer > from.layer ? to.base - ARRIVE_ABOVE : to.base + 6;
      const mid = Math.round((bus + end) / 2 + j * LABEL_STEP);
      const label = { x: to.x + last * ENTRY_STEP + LABEL_GAP, y: mid };

      return [
        {
          edge,
          path: `M${from.x} ${from.base + 2}V${bus}H${ex}V${end}`,
          light: { x: ex, y: mid },
          label,
          bottom: bus,
          right: label.x + LABEL_ROOM,
        },
      ];
    }

    const back = arriving.filter((e) => (at.get(e.from)?.layer ?? 0) > to.layer);
    const k = back.indexOf(edge);
    const lane = Math.max(from.x, to.x) + SLOT / 2 + k * BUS_STEP;
    const ex = to.x + (k + 1) * ENTRY_STEP;
    const turn = to.base + TURN_IN + k * BUS_STEP;
    const mid = Math.round((bus + turn) / 2);

    return [
      {
        edge,
        path: `M${from.x} ${from.base + 2}V${bus}H${lane}V${turn}H${ex}V${to.base + 6}`,
        light: { x: lane, y: mid },
        label: { x: lane + LABEL_GAP, y: mid },
        bottom: bus,
        right: lane + LABEL_GAP + LABEL_ROOM,
      },
    ];
  });
};

const callerOf = (map: ServiceMap, placed: ReadonlyArray<PlacedNode>) => {
  const roots = placed.filter((p) => map.caller.roots.has(p.node.name));
  const xs = roots.map((p) => p.x);
  const cx = mean(xs) ?? 0;
  const top = FIRST_BASE - ARRIVE_ABOVE;

  if (xs.length <= 1) return { at: { x: cx, y: 0 }, paths: [`M${cx} ${CALLER_LINE}V${top}`] };

  return {
    at: { x: cx, y: 0 },
    paths: [
      `M${cx} ${CALLER_LINE}V${CALLER_BUS}`,
      `M${Math.min(...xs)} ${CALLER_BUS}H${Math.max(...xs)}`,
      ...xs.map((x) => `M${x} ${CALLER_BUS}V${top}`),
    ],
  };
};

/** Below the last layer's label boxes. */
const FOOT_ROOM = 8;

export const mapLayout = (map: ServiceMap): MapLayout => {
  const { placed, width, depth } = place(map, layersOf(map));
  const drawn = routesOf(map, placed);
  const lowest = FIRST_BASE + (depth - 1) * PITCH + FOOT_ROOM;

  return {
    width: Math.max(width, ...drawn.map((r) => r.right)),
    // Room under the last layer only for connectors that leave it.
    height: Math.max(lowest, ...drawn.map((r) => r.bottom + FOOT_ROOM)),
    placed,
    routes: drawn.map(({ edge, path, light, label }) => ({ edge, path, light, label })),
    caller: callerOf(map, placed),
  };
};
