/**
 * Turn items as the conversation shows them: one shape for a completed
 * `TurnItem` and for an item still streaming (its `ItemProgress` and deltas).
 */
import type { Attachment, ToolKind, TurnItem } from "@polaris/protocol";
import { Match, Predicate } from "effect";
import type { LiveItem } from "../../../store/sessionModel.ts";
import { type NativeCall, nativeCall, nativeSummary } from "./nativeTools/index.ts";
import {
  type PolarisToolView,
  polarisToolView,
  type VisualizationView,
  visualizationView,
} from "./polarisTools/index.ts";
import { polarisTool } from "./runs.ts";
import {
  isPlumbing,
  kindOf,
  type McpName,
  mcpName,
  mcpSubject,
  skillName,
  type ToolResult,
  toolResult,
  toolSearchSubject,
} from "./toolCalls/index.ts";

export type ItemStatus = "running" | "completed" | "failed" | "declined";

export type FileChangeKind = "add" | "modify" | "delete";

export interface PlanStep {
  readonly text: string;
  readonly status: "pending" | "in-progress" | "completed";
  /** What the step is doing now (Claude's `activeForm`), when the Harness says. */
  readonly detail: string | null;
}

interface Base {
  readonly id: string;
  /** Still streaming: deltas or `ItemProgress`, no `TurnItemCompleted` yet. */
  readonly live: boolean;
}

export type ItemView =
  | (Base & { readonly kind: "message"; readonly text: string })
  /** A steer the Harness took, where it landed in the Turn. */
  | (Base & {
      readonly kind: "user";
      readonly text: string;
      /** What the steer carried; empty for a text-only one. */
      readonly attachments: ReadonlyArray<Attachment>;
    })
  | (Base & {
      readonly kind: "reasoning";
      readonly text: string;
      /** When the Harness began and finished thinking; null when unknown. */
      readonly startedAt: string | null;
      readonly endedAt: string | null;
    })
  | (Base & {
      readonly kind: "command";
      readonly command: string;
      readonly output: string;
      readonly exitCode: number | null;
      readonly status: ItemStatus;
      /** It moved to the background, where it keeps running as a background task. */
      readonly inBackground?: boolean;
    })
  | (Base & {
      readonly kind: "files";
      readonly changes: ReadonlyArray<{ readonly path: string; readonly kind: FileChangeKind }>;
      readonly status: ItemStatus;
    })
  | (Base & {
      readonly kind: "tool";
      readonly name: string;
      readonly summary: string;
      /** The summary unclipped, for the row's tooltip. */
      readonly full: string;
      /** The file it read or wrote, when its input names one: what opens in the editor. */
      readonly file: ToolFile | null;
      /** A Constellation tool (`claim`, `dispatch`…): its row carries the Constellation mark. */
      readonly polaris: boolean;
      /** A Polaris tool's own row (`polarisTools`); null for any other tool. */
      readonly view: PolarisToolView | null;
      /** A `visualize` call that is drawing or drew: it shows the Visualization, never a row. */
      readonly visualization: VisualizationView | null;
      /** What it does, as its driver classified it; null on older items it can't be told for. */
      readonly toolKind: ToolKind | null;
      /** The MCP server and tool, in words; null for any other tool. */
      readonly mcp: McpName | null;
      /** A Claude Code tool the registry phrases (`nativeTools`); null for any other. */
      readonly native: NativeCall | null;
      /** The Skill it loads, for a Skill call. */
      readonly skill: string | null;
      /** Loads other tools (ToolSearch): shown in an open run, never a phrase. */
      readonly plumbing: boolean;
      /** What it returned, in a line; null while running or when it returned nothing. */
      readonly result: ToolResult | null;
      /** As the Harness sent them, for Show raw. */
      readonly input: ToolInput;
      readonly output: unknown;
      readonly status: ItemStatus;
    })
  | (Base & {
      readonly kind: "plan";
      readonly steps: ReadonlyArray<PlanStep>;
      readonly explanation: string | null;
    })
  | (Base & { readonly kind: "error"; readonly message: string });

const SUMMARY_MAX = 160;

/** The tooltip's copy: long enough for any real command or path. */
const FULL_MAX = 4000;

/** Claude's tool a Subagent hands its report back with (`Subagent.report`). */
export const HANDBACK = "SubagentHandback";

/** Whatever the Harness passed the tool, as it arrived (the protocol keeps it opaque). */
export type ToolInput = Extract<TurnItem, { readonly _tag: "ToolCall" }>["input"];

/** The argument that says what a tool call touched, in the order Harnesses name them. */
const SUBJECT_KEYS = ["file_path", "path", "command", "pattern", "query", "url", "description"];

const clipTo = (max: number) => (text: string) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * What a tool call touched, on one line (rule/say-what-happened): its path, command or
 * query when it has one, else a string input as is, else compact JSON.
 */
export const toolSummary = (input: ToolInput, max = SUMMARY_MAX): string => {
  const clip = clipTo(max);

  if (input === null || input === undefined) return "";

  if (Predicate.isString(input)) return clip(input);

  const subject = SUBJECT_KEYS.map((key) =>
    Predicate.hasProperty(input, key) ? input[key] : undefined
  ).find(Predicate.isString);

  if (subject !== undefined) return clip(subject);

  return clip(JSON.stringify(input) ?? "");
};

const words = (tag: string) => tag.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

/** A Constellation tool's subject: its Task and what it does to it ("A1 · send back"). */
export const polarisSummary = (input: ToolInput): string => {
  if (!Predicate.isObject(input)) return "";
  const task = Predicate.hasProperty(input, "task") ? input["task"] : undefined;
  const action = Predicate.hasProperty(input, "action") ? input["action"] : undefined;
  const tag = Predicate.hasProperty(action, "_tag") ? action["_tag"] : undefined;

  return [task, Predicate.isString(tag) ? words(tag) : undefined]
    .filter(Predicate.isString)
    .join(" · ");
};

export interface ToolFile {
  readonly path: string;
  readonly line: number | null;
  /** An image (Codex's view_image, Claude Code's Read on a PNG): it opens in the image viewer. */
  readonly image: boolean;
}

const IMAGE_TYPES = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["bmp", "image/bmp"],
  ["avif", "image/avif"],
  ["svg", "image/svg+xml"],
]);

const extension = (path: string) => /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";

/** The image's MIME type from its extension; null for anything else. */
export const imageMime = (path: string): string | null => IMAGE_TYPES.get(extension(path)) ?? null;

const FILE_KEYS = ["file_path", "notebook_path"];

const stringAt = (input: ToolInput, key: string) => {
  const value = Predicate.hasProperty(input, key) ? input[key] : undefined;

  return Predicate.isString(value) && value !== "" ? value : undefined;
};

/**
 * The file a tool's input names (Claude Code's Read, Edit, Write), with Read's starting line;
 * a bare `path` counts only when it names an image (Codex's view_image).
 */
export const toolFile = (input: ToolInput): ToolFile | null => {
  if (!Predicate.isObject(input)) return null;
  const named = FILE_KEYS.map((key) => stringAt(input, key)).find(Predicate.isString);
  const bare = stringAt(input, "path");
  const path = named ?? (bare !== undefined && imageMime(bare) !== null ? bare : undefined);

  if (path === undefined) return null;
  const offset = Predicate.hasProperty(input, "offset") ? input["offset"] : undefined;

  return {
    path,
    line: Predicate.isNumber(offset) && offset >= 1 ? offset : null,
    image: imageMime(path) !== null,
  };
};

type ToolCallItem = Extract<TurnItem, { readonly _tag: "ToolCall" }>;

/** A call's subject: a Harness title, an MCP call's arguments, a Skill's name, or its input. */
const toolCallSummary = (item: ToolCallItem, max = SUMMARY_MAX) => {
  // The handback's input is the report, shown under its Subagent card; never as JSON.
  if (item.name === HANDBACK) return "";

  if (polarisTool(item.name) !== null) return polarisSummary(item.input);

  const mcp = mcpName(item.mcp, item.name);

  // An MCP row's verb names the server ("Called Paper"); its subject leads with the tool.
  if (mcp !== null)
    return [mcp.tool, item.title ?? mcpSubject(item.input)].filter((t) => t !== "").join(" · ");

  if (item.title !== null) return clipTo(max)(item.title);

  if (isPlumbing(item.name)) return toolSearchSubject(item.input);

  if (item.kind === "skill") return skillName(item.input) ?? toolSummary(item.input, max);

  return toolSummary(item.input, max);
};

const toolView = (i: ToolCallItem, live: boolean): ItemView => {
  const mcp = mcpName(i.mcp, i.name);
  const native = mcp === null ? nativeCall(i.name, i.input) : null;
  const subject = native === null ? null : nativeSummary(native);

  return {
    kind: "tool",
    id: i.id,
    live,
    name: i.name,
    summary: subject === null ? toolCallSummary(i) : clipTo(SUMMARY_MAX)(subject),
    full: subject ?? (mcp === null ? toolCallSummary(i, FULL_MAX) : toolSummary(i.input, FULL_MAX)),
    file: toolFile(i.input),
    polaris: polarisTool(i.name) !== null,
    view: polarisToolView(i),
    visualization: visualizationView(i),
    toolKind: kindOf(i.kind, mcp),
    mcp,
    native,
    skill: i.kind === "skill" ? skillName(i.input) : null,
    plumbing: isPlumbing(i.name),
    result: i.status === "running" ? null : toolResult(i.output),
    input: i.input,
    output: i.output,
    status: i.status,
  };
};

/** A native tool row re-read with its call changed (a Subagent's title for its id). */
export const withNativeCall = (
  item: Extract<ItemView, { kind: "tool" }>,
  native: NativeCall
): ItemView => {
  const subject = nativeSummary(native);

  return { ...item, native, summary: clipTo(SUMMARY_MAX)(subject), full: subject };
};

const fromItem = (item: TurnItem, live: boolean): ItemView =>
  Match.value(item).pipe(
    Match.tagsExhaustive({
      AssistantMessage: (i): ItemView => ({ kind: "message", id: i.id, live, text: i.text }),
      UserMessage: (i): ItemView => ({
        kind: "user",
        id: i.id,
        live,
        text: i.text,
        attachments: i.attachments ?? [],
      }),
      Reasoning: (i): ItemView => ({
        kind: "reasoning",
        id: i.id,
        live,
        text: i.text,
        startedAt: i.startedAt,
        endedAt: i.endedAt,
      }),
      CommandExecution: (i): ItemView => ({
        kind: "command",
        id: i.id,
        live,
        command: i.command,
        output: i.output,
        exitCode: i.exitCode,
        status: i.status,
        inBackground: Predicate.isString(i.backgroundTaskId),
      }),
      FileChange: (i): ItemView => ({
        kind: "files",
        id: i.id,
        live,
        changes: i.changes,
        status: i.status,
      }),
      ToolCall: (i): ItemView => toolView(i, live),
      Plan: (i): ItemView => ({
        kind: "plan",
        id: i.id,
        live,
        steps: i.steps,
        explanation: i.explanation,
      }),
      Error: (i): ItemView => ({ kind: "error", id: i.id, live, message: i.message }),
    })
  );

const completedViews = new WeakMap<TurnItem, ItemView>();

/** A completed item's view; cached per item, so unchanged rows keep their identity. */
export const completedItemView = (item: TurnItem): ItemView => {
  const cached = completedViews.get(item);

  if (cached !== undefined) return cached;
  const view = fromItem(item, false);

  completedViews.set(item, view);

  return view;
};

/** Streamed text wins over the progress snapshot, which may lag a frame behind it. */
const withStreamed = (view: ItemView, live: LiveItem): ItemView => {
  if ((view.kind === "message" || view.kind === "reasoning") && live.text !== "")
    return { ...view, text: live.text };

  if (view.kind === "command" && live.output !== "") return { ...view, output: live.output };

  return view;
};

/** An item in progress. Without `ItemProgress` its kind is a guess: output deltas mean a command. */
export const liveItemView = (id: string, live: LiveItem): ItemView => {
  if (live.item !== null) return withStreamed(fromItem(live.item, true), live);

  if (live.output !== "" && live.text === "") {
    return {
      kind: "command",
      id,
      live: true,
      command: "",
      output: live.output,
      exitCode: null,
      status: "running",
    };
  }

  return { kind: "message", id, live: true, text: live.text };
};

/** A command as the conversation shows it; the user's shell command is one too. */
export type ShellView = Extract<ItemView, { kind: "command" }>;

/** The user's shell command (`RunShellCommand`), which the Daemon ran: never an agent row. */
export const isUserShell = (item: TurnItem | null | undefined): boolean =>
  item != null && Predicate.isTagged(item, "CommandExecution") && item.origin === "user";

export interface OutputTail {
  readonly text: string;
  /** Lines left out before `text`. */
  readonly hidden: number;
}

/** The last `lines` lines of command output, and how many were left out. */
export const outputTail = (output: string, lines: number): OutputTail => {
  const trimmed = output.endsWith("\n") ? output.slice(0, -1) : output;
  const all = trimmed.split("\n");

  if (all.length <= lines) return { text: trimmed, hidden: 0 };

  return { text: all.slice(-lines).join("\n"), hidden: all.length - lines };
};

/** A Turn's output to copy: the agent's messages as Markdown, in order, a blank line apart. */
export const turnOutput = (items: ReadonlyArray<ItemView>): string =>
  items
    .flatMap((item) =>
      item.kind === "message" && item.text.trim() !== "" ? [item.text.trim()] : []
    )
    .join("\n\n");
