/**
 * The rail list (DESIGN.md, Rows, not a canvas): handovers at the top of the trunk, groups
 * with trailing counts, parents nested to any depth, Tasks, proposals; large Constellations
 * fold and filter.
 */
import type { TaskId } from "@polaris/protocol";
import { areaOverlaps } from "./areas.ts";
import { idRanges, span } from "./copy.ts";
import type { Facts, SubagentFact } from "./facts.ts";
import { arrange, flatten, type Placed } from "./forest.ts";
import { type Bucket, type TaskGlyphKind, type Tone, toneOf } from "./look.ts";
import { type TaskContext, type TaskRow, taskRow, TRUNK, type TreeLane } from "./task.ts";
import { childrenOf, isContainer, rootGroup } from "./tree.ts";
import type {
  AttemptData,
  ConstellationRecord,
  Handover,
  ProjectionData,
  Proposal,
  TaskData,
} from "./types.ts";

/** Past this many Tasks the tab folds groups, adds filters and drops rows to one line. */
export const LARGE = 100;

export type Filter = "all" | "needs-you" | "review" | "working" | "done";

export type Tally = Readonly<Record<Bucket, number>> & { readonly proposed: number };

export type RailRow =
  | { readonly kind: "handover"; readonly key: string; readonly handover: Handover }
  | {
      readonly kind: "group";
      readonly key: string;
      readonly group: string;
      readonly label: string;
      readonly total: number;
      readonly open: boolean;
      readonly tally: Tally;
      readonly glyph: TaskGlyphKind;
    }
  | TaskRow
  | ParentRow
  | {
      readonly kind: "proposal";
      readonly key: string;
      readonly proposal: Proposal;
      readonly by: string | null;
      readonly nested: boolean;
      readonly tree: TreeLane;
    }
  | {
      readonly kind: "waiting";
      readonly key: string;
      readonly group: string;
      readonly ids: string;
      readonly count: number;
      readonly tree: TreeLane;
    }
  | {
      readonly kind: "subagent";
      readonly key: string;
      /** The Task whose Attempt's session spawned it. */
      readonly parent: TaskRow;
      readonly subagent: SubagentFact;
      readonly age: string;
      readonly tree: TreeLane;
    }
  | { readonly kind: "note"; readonly key: string; readonly text: string };

/** A parent Task: foldable, its leaves' tally on the state lane, its rollup as the glyph. */
export interface ParentRow {
  readonly kind: "parent";
  readonly key: string;
  /** Its key in `RailOptions.folds`. */
  readonly fold: string;
  readonly task: TaskData;
  readonly projection: ProjectionData;
  readonly open: boolean;
  readonly tally: Tally;
  /** Leaf Tasks under it, at any depth. */
  readonly total: number;
  readonly glyph: TaskGlyphKind;
  readonly tree: TreeLane;
}

/** A parent's key in `RailOptions.folds`, apart from group names. */
export const parentFold = (id: string) => `parent\u0000${id}`;

export interface RailOptions {
  /** Groups the user opened (true) or folded (false); others take their default. */
  readonly folds: ReadonlyMap<string, boolean>;
  readonly filter: Filter;
  readonly query: string;
}

export const DEFAULT_RAIL: RailOptions = { folds: new Map(), filter: "all", query: "" };

const EMPTY_TALLY: Tally = {
  "needs-you": 0,
  review: 0,
  working: 0,
  blocked: 0,
  done: 0,
  waiting: 0,
  ended: 0,
  proposed: 0,
};

export const tallyOf = (rows: ReadonlyArray<TaskRow>, proposed = 0): Tally => {
  const tally: Record<keyof Tally, number> = { ...EMPTY_TALLY, proposed };

  for (const row of rows) tally[row.look.bucket] += 1;

  return tally;
};

const groupGlyph = (group: string, tally: Tally, total: number): TaskGlyphKind => {
  if (tally["needs-you"] > 0) return "needs-you";

  if (group === GATES) return "gate";

  if (tally.review + tally.working > 0) return "review";

  if (tally.blocked > 0) return "blocked";

  if (total > 0 && tally.done === total) return "accepted";

  return group === FUTURES ? "future" : "waiting";
};

const GATES = "Gates";

const FUTURES = "Futures";

/** The group a root sits in; large Constellations gather ungrouped Gates and proposals. */
const groupOf = (task: TaskData, large: boolean, group: string | null) => {
  if (group !== null) return group;

  if (!large) return null;

  if (task.kind === "gate") return GATES;

  return "Other tasks";
};

const MATCHES: Readonly<Record<Exclude<Filter, "all">, Bucket>> = {
  "needs-you": "needs-you",
  review: "review",
  working: "working",
  done: "done",
};

const matches = (row: TaskRow, filter: Filter, query: string) => {
  if (filter !== "all" && row.look.bucket !== MATCHES[filter]) return false;

  if (query === "") return true;
  const q = query.toLowerCase();
  const { task } = row;

  return (
    task.id.toLowerCase().includes(q) ||
    task.title.toLowerCase().includes(q) ||
    task.area.some((glob) => glob.toLowerCase().includes(q))
  );
};

const indexBy = (record: ConstellationRecord, facts: Facts, oneLine: boolean): TaskContext => {
  const { constellation } = record;
  const projections = new Map(record.projections.map((p) => [p.taskId, p]));
  const attempts = new Map<TaskId, Array<AttemptData>>();

  for (const a of constellation.attempts)
    attempts.set(a.taskId, [...(attempts.get(a.taskId) ?? []), a]);

  return {
    record,
    facts,
    projections,
    attempts,
    overlaps: areaOverlaps(constellation.tasks, projections),
    tasks: new Map(constellation.tasks.map((t) => [t.id, t])),
    blocks: blockers(constellation.attempts, projections),
    oneLine,
  };
};

/** Each Task named by a blocked Attempt, with the Tasks it blocks. */
const blockers = (
  attempts: ReadonlyArray<AttemptData>,
  projections: ReadonlyMap<TaskId, ProjectionData>
) => {
  const out = new Map<TaskId, Array<TaskId>>();

  for (const a of attempts) {
    if (a.state !== "blocked" || projections.get(a.taskId)?.latestAttemptId !== a.id) continue;

    for (const on of a.blockedOn) out.set(on, [...(out.get(on) ?? []), a.taskId]);
  }

  return out;
};

/** A Task in the tree: a leaf's row, or a container with its children. */
interface Node {
  readonly row: TaskRow;
  readonly children: ReadonlyArray<Node>;
  readonly container: boolean;
  /** Its leaves' rows, itself when it is one. */
  readonly leaves: ReadonlyArray<TaskRow>;
}

interface Group {
  readonly name: string;
  readonly nodes: Array<Node>;
  readonly proposals: Array<Proposal>;
}

const nodeOf = (
  task: TaskData,
  rows: ReadonlyMap<TaskId, TaskRow>,
  kids: ReadonlyMap<TaskId, ReadonlyArray<TaskData>>
): Node | null => {
  const row = rows.get(task.id);

  if (row === undefined) return null;
  const children = (kids.get(task.id) ?? []).flatMap((t) => nodeOf(t, rows, kids) ?? []);
  const container = isContainer(kids.get(task.id));

  return {
    row,
    children,
    container,
    leaves: container
      ? children.flatMap((c) => c.leaves)
      : [row, ...children.flatMap((c) => c.leaves)],
  };
};

/** Root Tasks in declaration order, gathered into groups in order of first appearance. */
const gather = (record: ConstellationRecord, ctx: TaskContext, large: boolean) => {
  const { tasks } = record.constellation;
  const kids = childrenOf(tasks);
  const rows = new Map(tasks.map((t) => [t.id, taskRow(t, true, ctx)]));
  const groups = new Map<string, Group>();
  const trunk: Array<Node> = [];
  const owner = new Map<string, string | null>();

  for (const task of tasks) {
    if (task.parent != null && ctx.tasks.has(task.parent)) continue;
    const node = nodeOf(task, rows, kids);

    if (node === null) continue;
    const name = groupOf(task, large, rootGroup(ctx.tasks, task));

    for (const leaf of [node.row, ...node.leaves]) owner.set(leaf.task.id, name);

    if (name === null) trunk.push(node);
    else {
      const group = groups.get(name) ?? { name, nodes: [], proposals: [] };

      group.nodes.push(node);
      groups.set(name, group);
    }
  }

  return { groups: [...groups.values()], trunk, loose: place(record, groups, owner, large) };
};

/** Proposals join their proposer's group (Futures when large); the rest stay on the trunk. */
const place = (
  record: ConstellationRecord,
  groups: Map<string, Group>,
  owner: ReadonlyMap<string, string | null>,
  large: boolean
) => {
  const loose: Array<Proposal> = [];

  for (const proposal of record.proposals) {
    const byTask = record.constellation.attempts.find((a) => a.id === proposal.by)?.taskId;
    const name = large ? FUTURES : (owner.get(byTask ?? "") ?? null);

    const group =
      name === null ? undefined : (groups.get(name) ?? { name, nodes: [], proposals: [] });

    if (group === undefined || name === null) loose.push(proposal);
    else {
      group.proposals.push(proposal);
      groups.set(name, group);
    }
  }

  return loose;
};

const proposalRow = (proposal: Proposal, record: ConstellationRecord, tree: TreeLane): RailRow => ({
  kind: "proposal",
  key: `proposal:${proposal.proposalId}`,
  proposal,
  by: record.constellation.attempts.find((a) => a.id === proposal.by)?.taskId ?? null,
  nested: tree.depth > 0,
  tree,
});

/** The lines a child of a row at `lane` passes: its ancestors', then its parent's own. */
const under = (lane: TreeLane): ReadonlyArray<boolean> =>
  lane.depth <= 1 ? [] : [...lane.through, !lane.last];

/** A working Attempt's Subagents, each a node under its row (not in large Constellations). */
const withSubagents = (row: TaskRow, facts: Facts): ReadonlyArray<RailRow> => {
  if (row.attempt === null || row.projection.state !== "working") return [row];
  const subagents = facts.worker(row.attempt).subagents;

  return [
    { ...row, tree: { ...row.tree, down: subagents.length > 0 } },
    ...subagents.map((subagent, n) => ({
      kind: "subagent" as const,
      key: `subagent:${subagent.id}`,
      parent: row,
      subagent,
      age: span(subagent.since, facts.now),
      tree: {
        depth: row.tree.depth + 1,
        through: under(row.tree),
        last: n === subagents.length - 1,
        down: false,
      },
    })),
  ];
};

interface Emit {
  readonly facts: Facts;
  readonly record: ConstellationRecord;
  readonly options: RailOptions;
  readonly large: boolean;
  readonly filtering: boolean;
  /** A Task's tone, for the "← X" ids. */
  readonly tone: (id: TaskId) => Tone;
}

const shownOf = (node: Node, emit: Emit) =>
  node.leaves.some((r) => matches(r, emit.options.filter, emit.options.query));

/** One child of a container, laid out once its place among its siblings is known. */
type Entry = (lane: TreeLane) => ReadonlyArray<RailRow>;

const lay = (entries: ReadonlyArray<Entry>, depth: number, through: ReadonlyArray<boolean>) =>
  entries.flatMap((entry, n) =>
    entry({ depth, through, last: n === entries.length - 1, down: false })
  );

/** Folds open by default unless the Constellation is large; needs-you or blocked opens one. */
const defaultOpen = (tally: Tally, large: boolean) =>
  !large || tally["needs-you"] > 0 || tally.blocked > 0;

/** Its own deps but the one it hangs under; a Gate's show as its input dots instead. */
const alsoOf = (placed: Placed<Node>, emit: Emit) => {
  const { task } = placed.item.row;

  if (task.kind === "gate") return [];

  return task.deps
    .filter((dep) => dep !== placed.host)
    .map((id) => ({ id: `${id}`, tone: emit.tone(id) }));
};

/** A leaf, with any canceled children and then the siblings that depend on it under it. */
const leafEntry =
  (placed: Placed<Node>, emit: Emit): Entry =>
  (lane) => {
    const node = placed.item;

    const kids = [
      ...childEntries(node.children, parentFold(node.row.task.id), emit),
      ...placedEntries(placed.under, `after\u0000${node.row.task.id}`, emit),
    ];

    const tree = { ...lane, down: kids.length > 0 };
    const row: TaskRow = { ...node.row, nested: lane.depth > 0, tree, also: alsoOf(placed, emit) };

    return [
      ...(emit.large ? [row] : withSubagents(row, emit.facts)),
      ...lay(kids, lane.depth + 1, under(lane)),
    ];
  };

const parentEntry =
  (node: Node, emit: Emit): Entry =>
  (lane) => {
    const { task, projection } = node.row;
    const fold = parentFold(task.id);
    const tally = tallyOf(node.leaves);
    const open = emit.filtering || (emit.options.folds.get(fold) ?? defaultOpen(tally, emit.large));
    const children = open ? childEntries(node.children, fold, emit) : [];

    const row: ParentRow = {
      kind: "parent",
      key: `parent:${task.id}`,
      fold,
      task,
      projection,
      open,
      tally,
      total: node.leaves.length,
      glyph: groupGlyph(task.id, tally, node.leaves.length),
      tree: { ...lane, down: children.length > 0 },
    };

    return [row, ...lay(children, lane.depth + 1, under(lane))];
  };

const entryOf = (placed: Placed<Node>, emit: Emit): Entry =>
  placed.item.container ? parentEntry(placed.item, emit) : leafEntry(placed, emit);

const flat = (node: Node): Placed<Node> => ({ item: node, host: null, under: [] });

/** Siblings hang under the sibling they depend on, except while filtering, which lists matches. */
const forest = (nodes: ReadonlyArray<Node>, filtering: boolean) =>
  filtering
    ? nodes.map(flat)
    : arrange(nodes, (n) => ({
        id: n.row.task.id,
        deps: n.row.task.deps,
        nests: n.row.task.kind !== "gate",
        hosts: !n.container && n.row.task.kind !== "gate",
      }));

const allWaiting = (p: Placed<Node>) =>
  flatten(p).every((n) => !n.container && n.row.look.bucket === "waiting");

/** A container's children, with large Constellations' waiting subtrees folded into one line. */
const childEntries = (
  nodes: ReadonlyArray<Node>,
  fold: string,
  emit: Emit
): ReadonlyArray<Entry> => {
  const shown = nodes.filter((n) => !emit.filtering || shownOf(n, emit));

  return placedEntries(forest(shown, emit.filtering), fold, emit);
};

/** Placed siblings as entries; in a large Constellation, waiting subtrees fold into one line. */
const placedEntries = (
  shown: ReadonlyArray<Placed<Node>>,
  fold: string,
  emit: Emit
): ReadonlyArray<Entry> => {
  const { large, filtering, options } = emit;
  const waitingKey = `${fold}\u0000waiting`;
  const foldWaiting = large && !filtering && !(options.folds.get(waitingKey) ?? false);
  const waitingRoots = foldWaiting ? shown.filter(allWaiting) : [];
  const waiting = waitingRoots.flatMap(flatten);
  const folded = waiting.length >= 2;

  const entries = (folded ? shown.filter((p) => !waitingRoots.includes(p)) : shown).map((p) =>
    entryOf(p, emit)
  );

  if (!folded) return entries;

  const line: Entry = (tree) => [
    {
      kind: "waiting",
      key: `waiting:${fold}`,
      group: waitingKey,
      ids: idRanges(waiting.map((n) => n.row.task.id)),
      count: waiting.length,
      tree,
    },
  ];

  return [...entries, line];
};

const groupRows = (group: Group, emit: Emit): ReadonlyArray<RailRow> => {
  const { options, large, filtering, record } = emit;

  if (filtering && !group.nodes.some((n) => shownOf(n, emit))) return [];
  const leaves = group.nodes.flatMap((n) => n.leaves);
  const tally = tallyOf(leaves, group.proposals.length);
  const open = filtering || (options.folds.get(group.name) ?? defaultOpen(tally, large));

  const header: RailRow = {
    kind: "group",
    key: `group:${group.name}`,
    group: group.name,
    label: group.name,
    total: leaves.length,
    open,
    tally,
    glyph: groupGlyph(group.name, tally, leaves.length),
  };

  if (!open) return [header];

  const proposals: ReadonlyArray<Entry> = filtering
    ? []
    : group.proposals.map((p) => (tree) => [proposalRow(p, record, tree)]);

  return [header, ...lay([...childEntries(group.nodes, group.name, emit), ...proposals], 1, [])];
};

export interface Rail {
  readonly rows: ReadonlyArray<RailRow>;
  readonly large: boolean;
  /** Counts for the filter chips, across every leaf Task. */
  readonly counts: Readonly<Record<Filter, number>>;
  /** Every leaf Task: what the strip, the counts and Needs you see (parents roll them up). */
  readonly tasks: ReadonlyArray<TaskRow>;
  /** Every Task id on the rail, parents too, for the id lane. */
  readonly ids: ReadonlyArray<string>;
  /** The deepest row, for the rail's geometry. */
  readonly depth: number;
}

/** The fold keys that hide a Task: its root's group and every parent above it. */
export const foldsAbove = (record: ConstellationRecord, taskId: string): ReadonlyArray<string> => {
  const byId = new Map<string, TaskData>(record.constellation.tasks.map((t) => [t.id, t]));
  const keys: Array<string> = [];
  let at: string | null = byId.get(taskId)?.parent ?? null;

  while (at !== null && !keys.includes(parentFold(at))) {
    keys.push(parentFold(at));
    at = byId.get(at)?.parent ?? null;
  }

  const task = byId.get(taskId);
  const group = task === undefined ? null : rootGroup(byId, task);

  return group === null ? keys : [group, ...keys];
};

const depthOf = (row: RailRow) =>
  row.kind === "task" ||
  row.kind === "parent" ||
  row.kind === "subagent" ||
  row.kind === "proposal" ||
  row.kind === "waiting"
    ? row.tree.depth
    : 0;

export const buildRail = (
  record: ConstellationRecord,
  facts: Facts,
  options: RailOptions = DEFAULT_RAIL
): Rail => {
  const large = record.constellation.tasks.length >= LARGE;
  const ctx = indexBy(record, facts, large);
  const filtering = options.filter !== "all" || options.query.trim() !== "";
  const tone = (id: TaskId) => toneOf(ctx.projections.get(id)?.state ?? "waiting");

  const emit: Emit = {
    facts,
    record,
    options: { ...options, query: options.query.trim() },
    large,
    filtering,
    tone,
  };

  const { groups, trunk, loose } = gather(record, ctx, large);
  const all = [...groups.flatMap((g) => g.nodes), ...trunk].flatMap((n) => n.leaves);
  const tally = tallyOf(all);

  const handovers: ReadonlyArray<RailRow> = filtering
    ? []
    : record.handovers.toReversed().map((handover) => ({
        kind: "handover",
        key: `handover:${handover.revision}`,
        handover,
      }));

  const note: ReadonlyArray<RailRow> =
    large && !filtering
      ? [
          {
            kind: "note",
            key: "note",
            text: `${all.length} tasks · a group opens when something in it needs you or is blocked`,
          },
        ]
      : [];

  const rows: ReadonlyArray<RailRow> = [
    ...handovers,
    ...groups.flatMap((g) => groupRows(g, emit)),
    ...childEntries(trunk, "", emit).flatMap((entry) => entry(TRUNK)),
    ...(filtering ? [] : loose.map((p) => proposalRow(p, record, TRUNK))),
    ...note,
  ];

  return {
    rows,
    large,
    counts: {
      all: all.length,
      "needs-you": tally["needs-you"],
      review: tally.review,
      working: tally.working,
      done: tally.done,
    },
    tasks: all,
    ids: record.constellation.tasks.map((t) => t.id),
    depth: rows.reduce((deepest, row) => Math.max(deepest, depthOf(row)), 0),
  };
};
