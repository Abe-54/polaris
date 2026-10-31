/**
 * The waterfall's rows: the tree flattened in order, without the children of collapsed nodes,
 * and, under a focus (Find spans, Errors only, one service), only matches and their ancestors.
 */
import type { SpanNode } from "./tree.ts";

export interface WaterfallRow {
  readonly node: SpanNode;
  readonly depth: number;
  /** Per ancestor level 1…depth-1: its line continues past this row. */
  readonly guides: ReadonlyArray<boolean>;
  /** The last of its siblings shown: its elbow ends here. */
  readonly last: boolean;
  /** It has children shown under it (a line runs down from its marker). */
  readonly open: boolean;
  /** Shown only to lead to a match; drawn quieter. */
  readonly context: boolean;
}

export interface RowOptions {
  /** Node keys whose children are hidden. */
  readonly collapsed: ReadonlySet<string>;
  /** When set, only nodes it accepts and their ancestors show, whatever is collapsed. */
  readonly focus: ((node: SpanNode) => boolean) | null;
}

/** Under a focus: the nodes it shows (matches and their ancestors), found bottom-up. */
const shownUnder = (
  nodes: ReadonlyArray<SpanNode>,
  focus: (node: SpanNode) => boolean,
  shown: Set<SpanNode>
): boolean => {
  let any = false;

  for (const node of nodes) {
    const below = shownUnder(node.children, focus, shown);

    if (below || focus(node)) {
      shown.add(node);
      any = true;
    }
  }

  return any;
};

export const waterfallRows = (
  roots: ReadonlyArray<SpanNode>,
  { collapsed, focus }: RowOptions
): ReadonlyArray<WaterfallRow> => {
  const shown = new Set<SpanNode>();

  if (focus !== null) shownUnder(roots, focus, shown);
  const visible = (node: SpanNode) => focus === null || shown.has(node);
  const rows: Array<WaterfallRow> = [];

  const walk = (nodes: ReadonlyArray<SpanNode>, depth: number, guides: ReadonlyArray<boolean>) => {
    const kids = nodes.filter(visible);

    kids.forEach((node, i) => {
      const last = i === kids.length - 1;

      const children =
        focus === null && collapsed.has(node.key) ? [] : node.children.filter(visible);

      rows.push({
        node,
        depth,
        guides,
        last,
        open: children.length > 0,
        context: focus !== null && !focus(node),
      });

      if (children.length > 0) walk(children, depth + 1, depth === 0 ? [] : [...guides, !last]);
    });
  };

  walk(roots, 0, []);

  return rows;
};

/** Every node with children: what "Collapse all" collapses. */
export const parentKeys = (roots: ReadonlyArray<SpanNode>): ReadonlySet<string> => {
  const keys = new Set<string>();
  const stack = [...roots];

  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.children.length > 0) keys.add(node.key);
    stack.push(...node.children);
  }

  return keys;
};
