/**
 * Tool Runs, as Claude Code and ChatDCA show them: consecutive successful Skills, reads,
 * searches, edits, commands, MCP calls and Claude Code's other tools fold into one line
 * ("Loaded grilling, read 3 files, ran 4 commands, called Paper 4 times, messaged a subagent")
 * that expands to each call; thinking between them folds in. A Turn's fetches and web searches
 * gather into one sources pill. Anything running, failed or declined keeps its row.
 */
import { plural } from "./format.ts";
import type { ItemView } from "./items.ts";
import { nativeJoinsRuns, nativePhrases, nativeVerb } from "./nativeTools/index.ts";
import { type Source, sourceOf } from "./sources/index.ts";
import type { SubagentCard } from "./subagents.ts";
import { toolSearchCount } from "./toolCalls/index.ts";

export type RunKind =
  | "skill"
  | "read"
  | "search"
  | "fetch"
  | "web-search"
  | "edit"
  | "shell"
  | "mcp"
  | "native"
  | "plumbing";

/** Older items' tools that join runs, by Claude Code's and Codex's names (compared lowercase). */
const TOOL_KINDS = new Map<string, RunKind>([
  ["read", "read"],
  ["notebookread", "read"],
  ["ls", "read"],
  ["grep", "search"],
  ["glob", "search"],
  ["search", "search"],
  ["webfetch", "fetch"],
  ["websearch", "web-search"],
  ["web_search", "web-search"],
]);

type ToolItem = Extract<ItemView, { kind: "tool" }>;

const toolRunKind = (item: ToolItem): RunKind | null => {
  // Polaris's own tools have purpose-built rows; a Visualization is never folded away.
  if (item.view !== null || item.polaris || item.visualization !== null) return null;

  // An image the agent viewed or made shows in the conversation, so it keeps its own row.
  if (item.file?.image === true) return null;

  if (item.plumbing) return "plumbing";

  if (item.native !== null) return nativeJoinsRuns(item.native) ? "native" : null;

  if (item.toolKind === null) return TOOL_KINDS.get(item.name.toLowerCase()) ?? null;

  return item.toolKind === "other" ? null : item.toolKind;
};

/** What a call does in a run, or null when it keeps its own row. */
export const runKind = (item: ItemView): RunKind | null => {
  if (item.live) return null;

  switch (item.kind) {
    case "tool":
      return item.status === "completed" ? toolRunKind(item) : null;
    case "command":
      return item.status === "completed" && (item.exitCode ?? 0) === 0 ? "shell" : null;
    case "files":
      return item.status === "completed" ? "edit" : null;
    default:
      return null;
  }
};

const count = plural;

/** Fixed phrase order whatever the call order; edits count distinct files. */
const PHRASES: ReadonlyArray<
  readonly [Exclude<RunKind, "skill" | "mcp" | "native" | "plumbing">, (n: number) => string]
> = [
  ["read", (n) => `read ${count(n, "file")}`],
  ["search", (n) => `searched for ${count(n, "pattern")}`],
  ["fetch", (n) => `fetched ${count(n, "page")}`],
  ["web-search", (n) => `searched the web ${count(n, "time")}`],
  ["edit", (n) => `edited ${count(n, "file")}`],
  ["shell", (n) => `ran ${count(n, "command")}`],
];

const editedFiles = (items: ReadonlyArray<ItemView>) =>
  new Set(items.flatMap((i) => (i.kind === "files" ? i.changes.map((c) => c.path) : []))).size;

/** "loaded grilling and domain-modeling"; from three on, "loaded 3 skills". */
const skillPhrase = (items: ReadonlyArray<ItemView>): ReadonlyArray<string> => {
  const names = new Set(
    items.flatMap((i) =>
      i.kind === "tool" && runKind(i) === "skill" ? [i.skill ?? i.summary] : []
    )
  );

  if (names.size === 0) return [];

  return names.size <= 2
    ? [`loaded ${[...names].join(" and ")}`]
    : [`loaded ${count(names.size, "skill")}`];
};

/** "called Paper 4 times", one per server, in the order the run first called it. */
const mcpPhrases = (items: ReadonlyArray<ItemView>): ReadonlyArray<string> => {
  const calls = new Map<string, number>();

  for (const item of items)
    if (item.kind === "tool" && item.mcp !== null && runKind(item) === "mcp")
      calls.set(item.mcp.server, (calls.get(item.mcp.server) ?? 0) + 1);

  return [...calls].map(([server, n]) =>
    n === 1 ? `called ${server} once` : `called ${server} ${n} times`
  );
};

/** "loaded 3 tools": what ToolSearch loaded by name; a search by keyword is never a phrase. */
const toolsPhrase = (items: ReadonlyArray<ItemView>): ReadonlyArray<string> => {
  const n = items.reduce(
    (sum, i) =>
      sum + (i.kind === "tool" && runKind(i) === "plumbing" ? toolSearchCount(i.input) : 0),
    0
  );

  return n === 0 ? [] : [`loaded ${count(n, "tool")}`];
};

const nativeCalls = (items: ReadonlyArray<ItemView>) =>
  items.flatMap((i) =>
    i.kind === "tool" && i.native !== null && runKind(i) === "native" ? [i.native] : []
  );

/** "Loaded grilling, read 2 files, ran 3 commands, called Paper 4 times, messaged a subagent". */
export const runSummary = (items: ReadonlyArray<ItemView>): string => {
  const counts = new Map<RunKind, number>();

  for (const item of items) {
    const kind = runKind(item);

    if (kind !== null) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  if (counts.has("edit")) counts.set("edit", editedFiles(items));

  const builtIn = PHRASES.flatMap(([kind, phrase]) => {
    const n = counts.get(kind) ?? 0;

    return n > 0 ? [phrase(n)] : [];
  });

  const text =
    [
      ...skillPhrase(items),
      ...toolsPhrase(items),
      ...builtIn,
      ...mcpPhrases(items),
      ...nativePhrases(nativeCalls(items)),
    ].join(", ") || "loaded tools";

  return text.charAt(0).toUpperCase() + text.slice(1);
};

export type Entry =
  | { readonly kind: "item"; readonly item: ItemView }
  | {
      readonly kind: "run";
      /** The first call's id: stable while later calls join. */
      readonly id: string;
      readonly items: ReadonlyArray<ItemView>;
      readonly summary: string;
    }
  /** A Subagent, where the Turn spawned it. */
  | { readonly kind: "subagent"; readonly card: SubagentCard }
  /** The pages it fetched and the searches it ran, where the first one was. */
  | {
      readonly kind: "sources";
      /** The first source's call id. */
      readonly id: string;
      readonly sources: ReadonlyArray<Source>;
    };

/** Finished thinking: it folds into a run when calls come on both sides of it. */
const between = (item: ItemView) => item.kind === "reasoning" && !item.live;

/**
 * Items in order, consecutive run calls folded with the thinking between them; a lone call
 * keeps its own row, as does thinking before or after a run. Fetches and web searches leave
 * the flow for one sources entry where the first of them was.
 */
export const groupItems = (items: ReadonlyArray<ItemView>): ReadonlyArray<Entry> => {
  const sources = items.flatMap((item) => {
    const source = sourceOf(item);

    return source === null ? [] : [{ item, source }];
  });

  const first = sources[0];

  if (first === undefined) return groupFlow(items);
  const taken = new Set(sources.map((s) => s.item));
  const at = items.indexOf(first.item);
  const position = new Map(items.map((item, n) => [item, n]));
  const entries = groupFlow(items.filter((item) => !taken.has(item)));

  const after = entries.findIndex((entry) => {
    const lead = firstItem(entry);

    return lead !== undefined && (position.get(lead) ?? 0) > at;
  });

  const pill: Entry = {
    kind: "sources",
    id: first.item.id,
    sources: sources.map((s) => s.source),
  };

  return after === -1
    ? [...entries, pill]
    : [...entries.slice(0, after), pill, ...entries.slice(after)];
};

/** The item an entry from `groupFlow` starts with. */
const firstItem = (entry: Entry): ItemView | undefined => {
  switch (entry.kind) {
    case "item":
      return entry.item;
    case "run":
      return entry.items[0];
    default:
      return undefined;
  }
};

const groupFlow = (items: ReadonlyArray<ItemView>): ReadonlyArray<Entry> => {
  const entries: Array<Entry> = [];
  let pending: Array<ItemView> = [];
  let held: Array<ItemView> = [];

  const emit = (list: ReadonlyArray<ItemView>) => {
    for (const item of list) entries.push({ kind: "item", item });
  };

  const flush = () => {
    const first = pending[0];
    const calls = pending.filter((item) => runKind(item) !== null).length;

    if (first !== undefined && calls > 1)
      entries.push({ kind: "run", id: first.id, items: pending, summary: runSummary(pending) });
    else emit(pending);
    emit(held);
    pending = [];
    held = [];
  };

  for (const item of items) {
    if (runKind(item) !== null) {
      pending.push(...held, item);
      held = [];
    } else if (between(item) && pending.length > 0) held.push(item);
    else {
      flush();
      entries.push({ kind: "item", item });
    }
  }

  flush();

  return entries;
};

const VERBS = new Map<string, readonly [running: string, done: string]>([
  ["read", ["Reading", "Read"]],
  ["notebookread", ["Reading", "Read"]],
  ["ls", ["Listing", "Listed"]],
  ["grep", ["Searching", "Searched"]],
  ["glob", ["Finding files", "Found files"]],
  ["webfetch", ["Fetching", "Fetched"]],
  ["websearch", ["Searching the web", "Searched the web"]],
  ["web_search", ["Searching the web", "Searched the web"]],
  ["subagenthandback", ["Handing back its report", "Handed back its report"]],
  ["view_image", ["Viewing an image", "Viewed an image"]],
  ["image_generation", ["Generating an image", "Generated an image"]],
]);

const POLARIS_TOOL = /^(?:mcp__polaris(?:_\d+)?__|polaris(?:_\d+)?\.)(.+)$/;

/** A Constellation tool's own name: Claude's `mcp__polaris__claim`, Codex's `polaris.claim`. */
export const polarisTool = (name: string): string | null => POLARIS_TOOL.exec(name)?.[1] ?? null;

/** The Constellation tools (`apps/daemon/src/mcp/tools`), as verbs. */
const POLARIS_VERBS = new Map<string, readonly [running: string, done: string]>([
  ["plan", ["Updating the constellation", "Updated the constellation"]],
  ["dispatch", ["Dispatching", "Dispatched"]],
  ["review", ["Reviewing a claim", "Reviewed a claim"]],
  ["answer", ["Answering", "Answered"]],
  ["message", ["Sending a message", "Sent a message"]],
  ["status", ["Checking the constellation", "Checked the constellation"]],
  ["set_state", ["Setting a task's state", "Set a task's state"]],
  ["progress", ["Reporting progress", "Reported progress"]],
  ["waiting_on", ["Saying what it waits on", "Said what it waits on"]],
  ["ask", ["Asking the lead", "Asked the lead"]],
  ["claim", ["Claiming", "Claimed"]],
  ["propose", ["Proposing a task", "Proposed a task"]],
  ["request_secret", ["Asking you for a secret", "Asked you for a secret"]],
]);

const sentenceCase = (name: string) => {
  const words = name.replaceAll("_", " ");

  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A tool's row label as a verb ("Read", "Searching", "Claimed"); its own name when unknown. */
export const toolVerb = (name: string, running: boolean): string => {
  const polaris = polarisTool(name);

  if (polaris !== null) {
    const verbs = POLARIS_VERBS.get(polaris);

    return verbs === undefined ? sentenceCase(polaris) : verbs[running ? 0 : 1];
  }

  const verbs = VERBS.get(name.toLowerCase());

  return verbs === undefined ? name : verbs[running ? 0 : 1];
};

/** A tool row's verb from what the call is: "Called Paper", "Loaded", else `toolVerb`. */
export const toolLabel = (item: ToolItem): string => {
  const running = item.status === "running";

  if (item.native !== null) return nativeVerb(item.native, running);

  if (item.mcp !== null && !item.polaris)
    return `${running ? "Calling" : "Called"} ${item.mcp.server}`;

  if (item.toolKind === "skill") return running ? "Loading" : "Loaded";

  if (item.plumbing) return running ? "Loading tools" : "Loaded tools";

  return toolVerb(item.name, running);
};

/** A tool call as a line on what an agent is doing now: "Messaging Fix tests · rebase". */
export const toolActivity = (item: ToolItem): string =>
  `${toolLabel({ ...item, status: "running" })} ${item.summary}`.trim();
