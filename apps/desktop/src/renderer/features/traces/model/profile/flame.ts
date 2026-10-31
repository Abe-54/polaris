/**
 * The flame chart's layout (DESIGN.md, Traces → Profile): the nodes in depth-first order with
 * each subtree's extent, so drawing and hit-testing skip whole subtrees that are off screen or
 * narrower than a pixel. A 50,000-node Profile draws only what can be seen.
 */
import type { ProfileDetail } from "@polaris/protocol";

export interface FlameLayout {
  /** Node indices in depth-first order, roots in their given (chronological) order. */
  readonly order: Int32Array;
  /** For each position in `order`, the position just after its subtree. */
  readonly after: Int32Array;
  /** For each position in `order`, its depth (roots are 0). */
  readonly depth: Uint16Array;
  /** For each node index, its position in `order`. */
  readonly positionOf: Int32Array;
  readonly start: Float64Array;
  readonly end: Float64Array;
  readonly functionOf: Int32Array;
  readonly levels: number;
  /** The last frame's end, in ms after the recording started. */
  readonly endMs: number;
}

const MAX_DEPTH = 65_535;

/** Children per node as a CSR list; a parent that isn't an earlier node makes a root. */
const childrenOf = (nodes: ProfileDetail["nodes"]) => {
  const n = nodes.length;
  const parent = new Int32Array(n).fill(-1);
  const count = new Int32Array(n + 1);

  nodes.forEach((node, i) => {
    const p = node.parent;

    if (p !== null && p < i) {
      parent[i] = p;
      count[p + 1] = (count[p + 1] ?? 0) + 1;
    }
  });

  for (let i = 0; i < n; i++) count[i + 1] = (count[i + 1] ?? 0) + (count[i] ?? 0);
  const fill = count.slice(0, n);
  const list = new Int32Array(n);

  for (let i = 0; i < n; i++) {
    const p = parent[i] ?? -1;

    if (p >= 0) list[(fill[p] = (fill[p] ?? 0) + 1) - 1] = i;
  }

  return { parent, first: count, list };
};

export const flameLayout = (detail: Pick<ProfileDetail, "nodes" | "hotFunctions">): FlameLayout => {
  const { nodes } = detail;
  const n = nodes.length;
  const { parent, first, list } = childrenOf(nodes);
  const order = new Int32Array(n);
  const after = new Int32Array(n);
  const depth = new Uint16Array(n);
  const positionOf = new Int32Array(n);
  const start = new Float64Array(n);
  const end = new Float64Array(n);
  const functionOf = new Int32Array(n);
  let levels = 0;
  let endMs = 0;
  let next = 0;
  // Iterative depth-first walk: a stack of [node, depth], children pushed in reverse.
  const stack: Array<number> = [];

  nodes.forEach((node, i) => {
    start[i] = node.startMs;
    end[i] = node.startMs + node.durationMs;
    functionOf[i] = node.functionIndex < detail.hotFunctions.length ? node.functionIndex : -1;
    endMs = Math.max(endMs, end[i] ?? 0);
  });

  for (let root = n - 1; root >= 0; root--) if ((parent[root] ?? -1) < 0) stack.push(root, 0);
  const open: Array<number> = [];

  while (stack.length > 0) {
    const d = stack.pop() ?? 0;
    const node = stack.pop() ?? 0;

    while (open.length > 0 && (depth[open.at(-1) ?? 0] ?? 0) >= d) after[open.pop() ?? 0] = next;
    order[next] = node;
    positionOf[node] = next;
    depth[next] = Math.min(d, MAX_DEPTH);
    levels = Math.max(levels, d + 1);
    open.push(next);
    next++;

    for (let c = (first[node + 1] ?? 0) - 1; c >= (first[node] ?? 0); c--)
      stack.push(list[c] ?? 0, d + 1);
  }

  for (const position of open) after[position] = next;

  return { order, after, depth, positionOf, start, end, functionOf, levels, endMs };
};

/** The shown part of a Profile, in ms after it started. */
export interface FlameWindow {
  readonly from: number;
  readonly to: number;
}

export interface FlameView {
  readonly window: FlameWindow;
  readonly width: number;
  /** The first level shown, and how many fit. */
  readonly top: number;
  readonly rows: number;
}

/** Calls `draw` for every frame at least `minPx` wide inside the view; returns how many. */
export const eachVisibleFrame = (
  layout: FlameLayout,
  view: FlameView,
  draw: (node: number, x: number, w: number, level: number) => void,
  minPx = 0.5
): number => {
  const { from, to } = view.window;
  const scale = view.width / Math.max(to - from, 1e-9);
  const bottom = view.top + view.rows;
  const total = layout.order.length;
  let drawn = 0;
  let p = 0;

  while (p < total) {
    const node = layout.order[p] ?? 0;
    const s = layout.start[node] ?? 0;
    const e = layout.end[node] ?? 0;
    const level = layout.depth[p] ?? 0;
    const w = (Math.min(e, to) - Math.max(s, from)) * scale;

    if (e <= from || s >= to || w < minPx || level >= bottom) {
      p = layout.after[p] ?? total;
      continue;
    }

    if (level >= view.top) {
      draw(node, (Math.max(s, from) - from) * scale, w, level);
      drawn++;
    }

    p++;
  }

  return drawn;
};

/** The node under `ms` at `level`, or null: descends from the root containing it. */
export const frameAt = (layout: FlameLayout, ms: number, level: number): number | null => {
  const total = layout.order.length;
  let p = 0;
  let limit = total;

  while (p < limit) {
    const node = layout.order[p] ?? 0;

    if ((layout.start[node] ?? 0) <= ms && ms < (layout.end[node] ?? 0)) {
      if ((layout.depth[p] ?? 0) === level) return node;
      limit = layout.after[p] ?? total;
      p++;
    } else p = layout.after[p] ?? total;
  }

  return null;
};

/** The first root frame that shows in `window`: where the keyboard starts. */
export const firstRootIn = (layout: FlameLayout, window: FlameWindow): number | null => {
  const total = layout.order.length;

  for (let p = 0; p < total; p = layout.after[p] ?? total) {
    const node = layout.order[p] ?? 0;

    if ((layout.end[node] ?? 0) > window.from && (layout.start[node] ?? 0) < window.to) return node;
  }

  return null;
};

/** Keyboard moves: Up to the parent, Down to the first child, Left/Right to a sibling. */
export const frameMove = (
  layout: FlameLayout,
  node: number,
  key: "up" | "down" | "left" | "right"
): number | null => {
  const p = layout.positionOf[node] ?? 0;
  const level = layout.depth[p] ?? 0;

  if (key === "down") {
    const child = p + 1;

    return child < (layout.after[p] ?? 0) ? (layout.order[child] ?? null) : null;
  }

  // The parent is the nearest earlier position one level up whose subtree holds p.
  let parent = p - 1;

  while (parent >= 0 && (layout.depth[parent] ?? 0) >= level) parent--;

  if (key === "up") return parent >= 0 ? (layout.order[parent] ?? null) : null;
  const siblings: Array<number> = [];
  const limit = parent >= 0 ? (layout.after[parent] ?? 0) : layout.order.length;

  for (let c = parent + 1; c < limit; c = layout.after[c] ?? limit) siblings.push(c);
  const at = siblings.indexOf(p) + (key === "right" ? 1 : -1);
  const sibling = siblings[at];

  return sibling === undefined ? null : (layout.order[sibling] ?? null);
};

/** Zooms `window` by `factor` (< 1 zooms in) around `ms`, kept inside [0, total]. */
export const zoomed = (
  window: FlameWindow,
  factor: number,
  ms: number,
  total: number
): FlameWindow => {
  const length = Math.min(total, Math.max(0.01, (window.to - window.from) * factor));
  const share = (ms - window.from) / Math.max(window.to - window.from, 1e-9);
  const from = Math.max(0, Math.min(total - length, ms - share * length));

  return { from, to: from + length };
};

/** Moves `window` by `ms`, kept inside [0, total]. */
export const panned = (window: FlameWindow, ms: number, total: number): FlameWindow => {
  const length = window.to - window.from;
  const from = Math.max(0, Math.min(total - length, window.from + ms));

  return { from, to: from + length };
};

/** `window` moved the least that shows part of `node`; unchanged when it already does. */
export const revealed = (
  layout: FlameLayout,
  window: FlameWindow,
  node: number,
  total: number
): FlameWindow => {
  const start = layout.start[node] ?? 0;
  const end = layout.end[node] ?? 0;

  if (end > window.from && start < window.to) return window;

  return panned(window, end <= window.from ? start - window.from : end - window.to, total);
};
