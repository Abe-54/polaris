// Portions adapted from apps/desktop/src/renderer/features/session/model/runs.ts and toolCalls/index.ts
/**
 * Tool steps named and folded as the Desktop App does (DESIGN.md, Tool runs): a call reads
 * as a verb ("Read", "Searching", "Called Paper"), and consecutive successful reads,
 * searches, fetches, edits, commands and MCP calls fold into one run ("Read 3 files, ran 4
 * commands"). Anything running, failed or declined, and every other kind, keeps its row.
 */
import type { TurnItem } from "@polaris/protocol";
import { Match, Predicate } from "effect";

export type RunKind =
  | "skill"
  | "read"
  | "search"
  | "fetch"
  | "web-search"
  | "edit"
  | "shell"
  | "mcp"
  | "plumbing";

type ToolCall = Extract<TurnItem, { readonly _tag: "ToolCall" }>;

type ToolInput = ToolCall["input"];

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

const POLARIS_TOOL = /^(?:mcp__polaris(?:_\d+)?__|polaris(?:_\d+)?\.)(.+)$/;

const CLAUDE_MCP = /^mcp__(.+?)__(.+)$/;

/** Claude Code's ToolSearch only loads other tools: it folds into a run, never a phrase. */
const isPlumbing = (name: string) => name === "ToolSearch";

const polarisTool = (name: string): string | null => POLARIS_TOOL.exec(name)?.[1] ?? null;

/** A server as people say it: connector prefixes gone, an all-lowercase name capitalized. */
const serverName = (server: string): string => {
  const plugin = /^plugin_[^_]+_(.+)$/.exec(server)?.[1];

  const spaced = (plugin ?? server)
    .replace(/^claude_ai_/, "")
    .replaceAll(/[_-]+/g, " ")
    .trim();

  if (spaced === "") return server;

  return spaced === spaced.toLowerCase()
    ? spaced.charAt(0).toUpperCase() + spaced.slice(1)
    : spaced;
};

/** A tool's own name in words: `write_html` and `writeHtml` read "write html". */
const toolWords = (tool: string): string =>
  tool
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll(/[_-]+/g, " ")
    .trim()
    .toLowerCase() || tool;

interface McpName {
  readonly server: string;
  readonly tool: string;
}

const mcpName = (item: ToolCall): McpName | null => {
  if (item.mcp != null)
    return { server: serverName(item.mcp.server), tool: toolWords(item.mcp.tool) };
  const [, server, tool] = CLAUDE_MCP.exec(item.name) ?? [];

  return server === undefined || tool === undefined
    ? null
    : { server: serverName(server), tool: toolWords(tool) };
};

const stringAt = (input: ToolInput, key: string): string | undefined => {
  const value = Predicate.hasProperty(input, key) ? input[key] : undefined;

  return Predicate.isString(value) && value.trim() !== "" ? value : undefined;
};

const skillName = (input: ToolInput): string | null =>
  Predicate.isString(input) ? input : (stringAt(input, "skill") ?? stringAt(input, "name") ?? null);

const toolRunKind = (item: ToolCall): RunKind | null => {
  // Polaris's own tools keep their rows.
  if (polarisTool(item.name) !== null) return null;

  if (isPlumbing(item.name)) return "plumbing";
  const kind = item.kind ?? (mcpName(item) === null ? null : "mcp");

  if (kind == null) return TOOL_KINDS.get(item.name.toLowerCase()) ?? null;

  return kind === "other" ? null : kind;
};

/** What a call does in a run; null when it keeps its own row (running, failed, any other kind). */
export const runKind = (item: TurnItem): RunKind | null =>
  Match.value(item).pipe(
    Match.tags({
      ToolCall: (call): RunKind | null => (call.status === "completed" ? toolRunKind(call) : null),
      CommandExecution: (command): RunKind | null =>
        command.status === "completed" && (command.exitCode ?? 0) === 0 ? "shell" : null,
      FileChange: (change): RunKind | null => (change.status === "completed" ? "edit" : null),
    }),
    Match.orElse((): RunKind | null => null)
  );

const GROUPED = new Intl.NumberFormat("en-US");

const count = (n: number, singular: string) =>
  `${GROUPED.format(n)} ${n === 1 ? singular : `${singular}s`}`;

/** Fixed phrase order whatever the call order; edits count distinct files. */
const PHRASES: ReadonlyArray<
  readonly [Exclude<RunKind, "skill" | "mcp" | "plumbing">, (n: number) => string]
> = [
  ["read", (n) => `read ${count(n, "file")}`],
  ["search", (n) => `searched for ${count(n, "pattern")}`],
  ["fetch", (n) => `fetched ${count(n, "page")}`],
  ["web-search", (n) => `searched the web ${count(n, "time")}`],
  ["edit", (n) => `edited ${count(n, "file")}`],
  ["shell", (n) => `ran ${count(n, "command")}`],
];

const calls = (items: ReadonlyArray<TurnItem>) =>
  items.flatMap((item) => (Predicate.isTagged(item, "ToolCall") ? [item] : []));

/** "loaded grilling and domain-modeling"; from three on, "loaded 3 skills". */
const skillPhrase = (items: ReadonlyArray<TurnItem>): ReadonlyArray<string> => {
  const names = new Set(
    calls(items).flatMap((call) =>
      runKind(call) === "skill" ? [skillName(call.input) ?? call.name] : []
    )
  );

  if (names.size === 0) return [];

  return names.size <= 2
    ? [`loaded ${[...names].join(" and ")}`]
    : [`loaded ${count(names.size, "skill")}`];
};

/** "called Paper 4 times", one per server, in the order the run first called it. */
const mcpPhrases = (items: ReadonlyArray<TurnItem>): ReadonlyArray<string> => {
  const servers = new Map<string, number>();

  for (const call of calls(items)) {
    const mcp = mcpName(call);

    if (mcp !== null && runKind(call) === "mcp")
      servers.set(mcp.server, (servers.get(mcp.server) ?? 0) + 1);
  }

  return [...servers].map(([server, n]) =>
    n === 1 ? `called ${server} once` : `called ${server} ${count(n, "time")}`
  );
};

/** "Loaded grilling, read 2 files, ran 3 commands, called Paper 4 times". */
export const runSummary = (items: ReadonlyArray<TurnItem>): string => {
  const counts = new Map<RunKind, number>();

  for (const item of items) {
    const kind = runKind(item);

    if (kind !== null) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  const edited = new Set(
    items.flatMap((item) =>
      Predicate.isTagged(item, "FileChange") ? item.changes.map((change) => change.path) : []
    )
  ).size;

  if (counts.has("edit")) counts.set("edit", edited);

  const builtIn = PHRASES.flatMap(([kind, phrase]) => {
    const n = counts.get(kind) ?? 0;

    return n > 0 ? [phrase(n)] : [];
  });

  const text =
    [...skillPhrase(items), ...builtIn, ...mcpPhrases(items)].join(", ") || "loaded tools";

  return text.charAt(0).toUpperCase() + text.slice(1);
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
]);

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
]);

const sentenceCase = (name: string) => {
  const words = name.replaceAll("_", " ");

  return words.charAt(0).toUpperCase() + words.slice(1);
};

const polarisVerb = (tool: string, running: boolean): string => {
  const verbs = POLARIS_VERBS.get(tool);

  return verbs === undefined ? sentenceCase(tool) : verbs[running ? 0 : 1];
};

const toolVerb = (call: ToolCall, running: boolean): string => {
  const polaris = polarisTool(call.name);
  const mcp = mcpName(call);

  if (polaris !== null) return polarisVerb(polaris, running);

  if (mcp !== null) return `${running ? "Calling" : "Called"} ${mcp.server}`;

  if (call.kind === "skill") return running ? "Loading" : "Loaded";

  if (isPlumbing(call.name)) return running ? "Loading tools" : "Loaded tools";
  const verbs = VERBS.get(call.name.toLowerCase());

  return verbs === undefined ? call.name : verbs[running ? 0 : 1];
};

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The argument that says what a call touched, in the order Harnesses name them. */
const SUBJECT_KEYS = ["command", "pattern", "query", "url", "description"];

/** A built-in tool's subject: the file it touched, its string input, or its first named argument. */
const inputSubject = (input: ToolInput): string => {
  const path = stringAt(input, "file_path") ?? stringAt(input, "path");

  if (path !== undefined) return basename(path);

  if (Predicate.isString(input)) return input;

  return SUBJECT_KEYS.map((key) => stringAt(input, key)).find(Predicate.isString) ?? "";
};

const toolSubject = (call: ToolCall): string => {
  const mcp = mcpName(call);

  if (polarisTool(call.name) !== null || isPlumbing(call.name)) return "";

  if (mcp !== null) return call.title == null ? mcp.tool : `${mcp.tool} · ${call.title}`;

  return call.kind === "skill" ? (skillName(call.input) ?? "") : inputSubject(call.input);
};

const firstLine = (text: string) => text.trim().split("\n", 1)[0] ?? "";

/** A tool row's label: its verb, then what it touched ("Read serve.ts", "Called Linear save issue"). */
export const toolLabel = (call: ToolCall): string => {
  const verb = toolVerb(call, call.status === "running");
  const subject = firstLine(toolSubject(call));

  // A Harness's own title already says what happened ("Read the Orchestrator notes").
  if (call.title != null && mcpName(call) === null && polarisTool(call.name) === null)
    return firstLine(call.title);

  return subject === "" ? verb : `${verb} ${subject}`;
};
