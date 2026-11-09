/**
 * Translates Agent SDK messages into normalized `HarnessEvent`s and `TurnItem`s.
 *
 * Stateful but free of effects, so it is unit-testable on recorded messages.
 * Turn accounting (which `result` ends which Turn) lives in the session, not here.
 *
 * A tool call is live progress (`ItemUpdated`, `running`) when its `tool_use`
 * block arrives, and one `ItemCompleted` with the final status when its
 * `tool_result` does. TodoWrite updates the Turn's plan live the same way; the
 * plan is completed once, with its last state, when the Turn ends.
 *
 * A thinking block is live progress from its stream start, and completes with
 * the times it started and stopped streaming. Each main-scope assistant
 * message reports how full the context window is (`ContextUsed`).
 */
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { type ReplyStats, SubagentId, type TurnId, TurnItem } from "@polaris/protocol";
import { Option, Predicate } from "effect";
import { ClaudeBackgroundTasks } from "./backgroundTasks.ts";
import { ReplyTimer } from "./replyStats.ts";
import { toolIdentity } from "./toolIdentity.ts";
import { type ContextBreakdown, HarnessEvent } from "../HarnessDriver.ts";
import {
  type AssistantBlock,
  decodeAssistantContent,
  decodeTodos,
  decodeToolResultContent,
  decodeToolResults,
  present,
  type ToolPayload,
  type ToolResult,
  toolFields,
} from "./payloads.ts";

type ToolStatus = "running" | "completed" | "failed" | "declined";

const {
  ContextUsed,
  CursorAssigned,
  ItemCompleted,
  ItemDelta,
  ItemUpdated,
  SubagentEnded,
  SubagentStarted,
} = HarnessEvent;

/** Where an item belongs: the Turn, or one of its Subagents. */
interface Scope {
  readonly turnId: TurnId;
  readonly subagentId: SubagentId | null;
}

/** An item event's `turnId`, and its `subagentId` when it is a Subagent's. */
const scoped = (scope: Scope) =>
  scope.subagentId === null
    ? { turnId: scope.turnId }
    : { turnId: scope.turnId, subagentId: scope.subagentId };

/** The key of a scope's live plan: its Turn's, or its Subagent's own. */
const planKey = (scope: Scope): string => scope.subagentId ?? scope.turnId;

/** A reply block, kept to complete again with its model call's stats. */
interface Reply {
  readonly scope: Scope;
  readonly id: string;
  readonly text: string;
}

const replyCompleted = (reply: Reply, stats: ReplyStats | null): HarnessEvent =>
  ItemCompleted({
    ...scoped(reply.scope),
    item: TurnItem.cases.AssistantMessage.make({ id: reply.id, text: reply.text, stats }),
  });

/** The tool that spawns a Subagent: `Agent`, called `Task` before Claude Code 2.1. */
const SPAWNS_SUBAGENT = new Set(["Agent", "Task"]);

type BlockDelta = Extract<
  SDKPartialAssistantMessage["event"],
  { readonly type: "content_block_delta" }
>["delta"];

/** A streamed text or thinking chunk; null for other deltas (tool input JSON, signatures). */
const deltaText = (delta: BlockDelta): string | null => {
  switch (delta.type) {
    case "text_delta":
      return delta.text;
    case "thinking_delta":
      return delta.thinking;
    default:
      return null;
  }
};

/** Text of a `tool_result` content (a string or an array of content blocks). */
export const toolResultText = (content: ToolPayload): string =>
  Option.match(decodeToolResultContent(content), {
    onNone: () => "",
    onSome: (decoded) =>
      Predicate.isString(decoded)
        ? decoded
        : present(decoded)
            .map((block) => block.text)
            .join("\n"),
  });

const PLAN_STATUS = {
  pending: "pending",
  in_progress: "in-progress",
  completed: "completed",
} as const;

export const planSteps = (input: ToolPayload) =>
  Option.match(decodeTodos(input), {
    onNone: () => [],
    onSome: ({ todos }) =>
      present(todos).map((todo) => ({
        text: todo.content,
        status: PLAN_STATUS[todo.status],
        detail: todo.activeForm === todo.content ? null : todo.activeForm,
      })),
  });

/** The live plan of a Turn (or of a Subagent: its key), from a TodoWrite call's input. */
export const planItem = (key: string, input: ToolPayload): TurnItem =>
  TurnItem.cases.Plan.make({ id: `plan:${key}`, steps: planSteps(input), explanation: null });

type MessageUsage = SDKAssistantMessage["message"]["usage"];

/** The tokens one model call carried: its whole prompt (cached or not) and its output. */
const contextTokens = (usage: MessageUsage): number =>
  usage.input_tokens +
  (usage.cache_creation_input_tokens ?? 0) +
  (usage.cache_read_input_tokens ?? 0) +
  usage.output_tokens;

/** One tool call, in any state. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: ToolPayload;
  readonly cwd: string;
  readonly status: ToolStatus;
  readonly resultText: string | null;
  /** The structured `tool_use_result`, when the SDK attached one. */
  readonly structured: ToolPayload;
}

const FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

const commandItem = (call: ToolCall): TurnItem => {
  const result = toolFields(call.structured);
  const streams = [result.stdout, result.stderr];

  const output =
    result.stdout !== null || result.stderr !== null
      ? streams.flatMap((text) => (text ? [text] : [])).join("\n")
      : (call.resultText ?? "");

  return TurnItem.cases.CommandExecution.make({
    id: call.id,
    command: toolFields(call.input).command ?? "",
    cwd: call.cwd,
    output,
    // Claude Code reports a non-zero exit only as an error result, without the code.
    exitCode: null,
    status: call.status,
    backgroundTaskId: result.backgroundTaskId,
  });
};

const fileChangeKind = (call: ToolCall, editMode: string | null) => {
  if (toolFields(call.structured).type === "create") return "add";

  return call.name === "NotebookEdit" && editMode === "delete" ? "delete" : "modify";
};

const fileChangeItem = (call: ToolCall): TurnItem => {
  const input = toolFields(call.input);

  return TurnItem.cases.FileChange.make({
    id: call.id,
    changes: [
      {
        path: input.file_path ?? input.notebook_path ?? "",
        kind: fileChangeKind(call, input.edit_mode),
      },
    ],
    status: call.status,
  });
};

/** Build the `TurnItem` for one tool call, in any state. */
export const toolItem = (call: ToolCall): TurnItem => {
  if (call.name === "Bash") return commandItem(call);

  if (FILE_TOOLS.has(call.name)) return fileChangeItem(call);

  return TurnItem.cases.ToolCall.make({
    id: call.id,
    name: call.name,
    ...toolIdentity(call.name),
    input: call.input,
    output: call.status === "running" ? null : (call.structured ?? call.resultText),
    status: call.status,
  });
};

interface OpenTool {
  readonly name: string;
  readonly input: ToolPayload;
  readonly scope: Scope;
}

/** A Subagent Claude Code is running: where it belongs, and whether it runs in the background. */
interface OpenSubagent {
  readonly turnId: TurnId;
  readonly background: boolean;
  report: string | null;
}

export class ClaudeTranslator {
  private cursor: string | null;
  private turnId: TurnId | null = null;
  /** Message id of the stream currently being delivered, per scope (`""` for the Turn's own). */
  private readonly streamMessageIds = new Map<string, string>();
  /** How many content blocks of each assistant message id were delivered. */
  private readonly delivered = new Map<string, number>();
  private readonly tools = new Map<string, OpenTool>();
  private readonly declined = new Set<string>();
  /** The latest TodoWrite plan of each Turn or Subagent (`planKey`), completed when it ends. */
  private readonly plans = new Map<string, { readonly scope: Scope; readonly item: TurnItem }>();
  /** Subagents by the id of the tool call that spawned them. */
  private readonly subagents = new Map<string, OpenSubagent>();
  private readonly backgroundTasks = new ClaudeBackgroundTasks();
  /** When each thinking block still open started and (once its stream stopped) ended. */
  private readonly thinking = new Map<string, { startedAt: string; endedAt: string | null }>();
  /** The Model's context window, once Claude Code has said; and the last usage reported. */
  private contextWindow: number | null = null;
  private contextUsed: number | null = null;
  private readonly replies = new ReplyTimer<Reply>();

  constructor(
    private readonly cwd: string,
    cursor: string | null = null,
    private readonly now: () => string = () => new Date().toISOString()
  ) {
    this.cursor = cursor;
  }

  /**
   * Claude Code's own count (`getContextUsage`, or a result's `modelUsage`):
   * it sets the window later reports use, and is reported itself.
   */
  onContextUsage(
    usedTokens: number | null,
    windowTokens: number | null,
    breakdown?: ContextBreakdown,
    compacted?: {
      readonly trigger: "auto" | "manual";
      readonly beforeTokens: number;
      readonly afterTokens: number | null;
    }
  ): HarnessEvent[] {
    if (windowTokens !== null && windowTokens > 0) this.contextWindow = windowTokens;
    const used = usedTokens ?? this.contextUsed;

    if (used === null) return [];
    this.contextUsed = used;

    return [
      ContextUsed({ usedTokens: used, windowTokens: this.contextWindow, breakdown, compacted }),
    ];
  }

  get sessionCursor(): string | null {
    return this.cursor;
  }

  /** Reports consumed by the next parent model call. */
  takeReports() {
    return this.backgroundTasks.takeReports();
  }

  beginTurn(turnId: TurnId): void {
    this.turnId = turnId;
    this.replies.requested("", this.nowMs());
  }

  private nowMs(): number {
    return Date.parse(this.now());
  }

  endTurn(): void {
    this.turnId = null;
    this.streamMessageIds.delete("");

    // A background Subagent may still be delivering blocks.
    if (this.subagents.size === 0) this.delivered.clear();
  }

  /** A permission request's Turn, and the Subagent whose call it is once its `tool_use` was seen. */
  approvalScope(turnId: TurnId, toolUseId: string) {
    return scoped({ turnId, subagentId: this.tools.get(toolUseId)?.scope.subagentId ?? null });
  }

  /** The user (or an interrupt) declined this tool call; its result reads as `declined`. */
  markDeclined(toolUseId: string): void {
    this.declined.add(toolUseId);
  }

  /**
   * At Turn end: items still open (e.g. interrupted mid-tool) complete as failed or
   * declined, and the Turn's plan completes with its last state.
   */
  closeOpenTools(turnId: TurnId, status: "failed" | "declined"): HarnessEvent[] {
    return this.closeScope({ turnId, subagentId: null }, status);
  }

  /** What a Turn or Subagent left open completes: its plan, and its tool calls as `status`. */
  private closeScope(scope: Scope, status: "failed" | "declined"): HarnessEvent[] {
    const events: HarnessEvent[] = [];
    const plan = this.plans.get(planKey(scope));

    if (plan !== undefined) {
      this.plans.delete(planKey(scope));
      events.push(ItemCompleted({ ...scoped(scope), item: plan.item }));
    }

    for (const [id, tool] of this.tools) {
      if (tool.scope.turnId !== scope.turnId || tool.scope.subagentId !== scope.subagentId) {
        continue;
      }

      this.tools.delete(id);

      if (tool.name === "TodoWrite") continue;
      events.push(
        ItemCompleted({
          ...scoped(scope),
          item: toolItem({
            id,
            name: tool.name,
            input: tool.input,
            cwd: this.cwd,
            status,
            resultText: null,
            structured: null,
          }),
        })
      );
    }

    return events;
  }

  onMessage(message: SDKMessage): HarnessEvent[] {
    switch (message.type) {
      case "system":
        return this.onSystem(message);
      case "stream_event":
        return this.withScope(message.parent_tool_use_id, (scope) =>
          this.onStreamEvent(scope, message.event)
        );
      case "assistant":
        return this.withScope(message.parent_tool_use_id, (scope) =>
          this.onAssistant(scope, message.message)
        );
      case "user":
        // Tool results read their scope from the tool call they answer.
        return ("isReplay" in message && message.isReplay) ||
          (message.parent_tool_use_id !== null && !this.subagents.has(message.parent_tool_use_id))
          ? []
          : this.onUser(message.message.content, message.tool_use_result);
      default:
        return [];
    }
  }

  /**
   * The scope of a frame: the Turn in flight for the Turn's own frames, the
   * Subagent's for frames with its `parent_tool_use_id`; none for others.
   */
  private withScope(parent: string | null, f: (scope: Scope) => HarnessEvent[]): HarnessEvent[] {
    if (parent === null)
      return this.turnId === null ? [] : f({ turnId: this.turnId, subagentId: null });
    const subagent = this.subagents.get(parent);

    return subagent === undefined
      ? []
      : f({ turnId: subagent.turnId, subagentId: SubagentId.make(parent) });
  }

  private onSystem(message: Extract<SDKMessage, { type: "system" }>): HarnessEvent[] {
    if (message.subtype === "init") {
      if (message.session_id === this.cursor) return [];
      this.cursor = message.session_id;

      return [CursorAssigned({ cursor: message.session_id })];
    }

    if (message.subtype === "background_tasks_changed")
      return this.backgroundTasks.onMessage(message);

    if (message.subtype === "task_updated") return this.backgroundTasks.onMessage(message);

    if (message.subtype === "task_started")
      return [...this.backgroundTasks.onMessage(message), ...this.onTaskStarted(message)];

    if (message.subtype === "compact_boundary") {
      const { trigger, pre_tokens: before, post_tokens: after } = message.compact_metadata;

      return this.onContextUsage(after ?? null, null, undefined, {
        trigger,
        beforeTokens: before,
        afterTokens: after ?? null,
      });
    }

    return message.subtype === "task_notification"
      ? [...this.backgroundTasks.onMessage(message), ...this.onTaskNotification(message)]
      : [];
  }

  /** A Subagent starts: only one an Agent tool call spawned in the Turn in flight. */
  private onTaskStarted(message: Extract<SDKMessage, { subtype: "task_started" }>): HarnessEvent[] {
    const toolUseId = message.tool_use_id;
    const tool = toolUseId === undefined ? undefined : this.tools.get(toolUseId);

    if (toolUseId === undefined || tool === undefined || !SPAWNS_SUBAGENT.has(tool.name)) return [];

    if (tool.scope.subagentId !== null || this.subagents.has(toolUseId)) return [];
    this.subagents.set(toolUseId, {
      turnId: tool.scope.turnId,
      background: message.is_backgrounded === true,
      report: null,
    });
    this.replies.requested(toolUseId, this.nowMs());
    const input = toolFields(tool.input);

    return [
      SubagentStarted({
        turnId: tool.scope.turnId,
        subagentId: SubagentId.make(toolUseId),
        parentItemId: toolUseId,
        title: message.description,
        agent: message.subagent_type ?? input.subagent_type,
        model: input.model,
        background: message.is_backgrounded === true,
      }),
    ];
  }

  private onTaskNotification(
    message: Extract<SDKMessage, { subtype: "task_notification" }>
  ): HarnessEvent[] {
    const toolUseId = message.tool_use_id;

    if (toolUseId === undefined) return [];

    const subagent = this.subagents.get(toolUseId);

    return this.endSubagent(
      toolUseId,
      message.status === "stopped" ? "interrupted" : message.status,
      subagent?.report ?? message.summary
    );
  }

  /** A Subagent ends: its open items close, then `SubagentEnded`. */
  private endSubagent(
    toolUseId: string,
    status: "completed" | "failed" | "interrupted",
    report?: string | null
  ): HarnessEvent[] {
    const subagent = this.subagents.get(toolUseId);

    if (subagent === undefined) return [];
    this.subagents.delete(toolUseId);
    const subagentId = SubagentId.make(toolUseId);
    const scope = { turnId: subagent.turnId, subagentId };

    return [
      ...this.closeScope(scope, status === "completed" ? "failed" : "declined"),
      SubagentEnded({ subagentId, status, report: report ?? subagent.report }),
    ];
  }

  /** Runs once per streamed chunk; the SDK types these events, so they need no parsing. */
  private onStreamEvent(scope: Scope, event: SDKPartialAssistantMessage["event"]): HarnessEvent[] {
    const key = scope.subagentId ?? "";

    if (event.type === "message_start") {
      this.streamMessageIds.set(key, event.message.id);
      this.replies.started(key, event.message.id, this.nowMs());

      return [];
    }

    const messageId = this.streamMessageIds.get(key);

    if (messageId === undefined) return [];

    switch (event.type) {
      case "content_block_start":
        return event.content_block.type === "thinking"
          ? this.startThinking(scope, `${messageId}:${event.index}`)
          : [];
      case "content_block_stop": {
        const open = this.thinking.get(`${messageId}:${event.index}`);

        if (open !== undefined) open.endedAt = this.now();

        return [];
      }

      case "content_block_delta": {
        const text = deltaText(event.delta);
        const itemId = `${messageId}:${event.index}`;

        return text === null || text === ""
          ? []
          : [ItemDelta({ ...scoped(scope), itemId, field: "text", text })];
      }

      case "message_delta": {
        const ended = this.replies.ended(key, event.usage.output_tokens, this.nowMs());

        return ended === null ? [] : [replyCompleted(ended.reply, ended.stats)];
      }

      default:
        return [];
    }
  }

  /** A thinking block starts streaming: it shows live, timed from now. */
  private startThinking(scope: Scope, id: string): HarnessEvent[] {
    const startedAt = this.now();
    this.thinking.set(id, { startedAt, endedAt: null });
    const item = TurnItem.cases.Reasoning.make({ id, text: "", startedAt, endedAt: null });

    return [ItemUpdated({ ...scoped(scope), item })];
  }

  /** A thinking block's final item, with its times when its stream was seen. */
  private thinkingItem(scope: Scope, id: string, text: string): HarnessEvent[] {
    const open = this.thinking.get(id);
    this.thinking.delete(id);

    // Nothing streamed and nothing to show: there is no row to keep.
    if (open === undefined && text === "") return [];
    const startedAt = open?.startedAt ?? null;
    const endedAt = open === undefined ? null : (open.endedAt ?? this.now());
    const item = TurnItem.cases.Reasoning.make({ id, text, startedAt, endedAt });

    return [ItemCompleted({ ...scoped(scope), item })];
  }

  private onAssistant(scope: Scope, message: SDKAssistantMessage["message"]): HarnessEvent[] {
    const blocks = decodeAssistantContent(message.content);
    const usage = scope.subagentId === null ? this.onMessageUsage(message.usage) : [];

    if (Option.isNone(blocks)) return usage;

    const messageId = message.id;

    return blocks.value
      .flatMap((block) => {
        // Blocks of one message arrive in order, one or more per SDK message, so the running
        // count is the block's index: the same id its stream deltas used.
        const index = this.delivered.get(messageId) ?? 0;
        this.delivered.set(messageId, index + 1);

        return block === null
          ? []
          : this.onAssistantBlock(scope, { messageId, id: `${messageId}:${index}` }, block);
      })
      .concat(usage);
  }

  /** The Turn's own model call: how full the context is now, when that changed. */
  private onMessageUsage(usage: MessageUsage | undefined): HarnessEvent[] {
    if (usage === undefined) return [];
    const used = contextTokens(usage);

    return used === 0 || used === this.contextUsed ? [] : this.onContextUsage(used, null);
  }

  private onAssistantBlock(
    scope: Scope,
    { messageId, id }: { readonly messageId: string; readonly id: string },
    block: AssistantBlock
  ): HarnessEvent[] {
    switch (block.type) {
      case "text": {
        if (block.text === "") return [];
        const reply = { scope, id, text: block.text };
        const stats = this.replies.reply(scope.subagentId ?? "", messageId, reply);

        return [replyCompleted(reply, stats)];
      }

      case "thinking":
        return this.thinkingItem(scope, id, block.thinking);
      case "tool_use":
        return this.onToolUse(scope, block.id, block.name ?? "unknown", block.input);
    }
  }

  private onToolUse(scope: Scope, id: string, name: string, input: ToolPayload): HarnessEvent[] {
    this.tools.set(id, { name, input, scope });

    if (name === "SubagentHandback" && scope.subagentId !== null) {
      const subagent = this.subagents.get(scope.subagentId);

      if (subagent !== undefined) subagent.report = toolFields(input).message;
    }

    if (name === "TodoWrite") {
      const plan = planItem(planKey(scope), input);
      this.plans.set(planKey(scope), { scope, item: plan });

      return [ItemUpdated({ ...scoped(scope), item: plan })];
    }

    return [
      ItemUpdated({
        ...scoped(scope),
        item: toolItem({
          id,
          name,
          input,
          cwd: this.cwd,
          status: "running",
          resultText: null,
          structured: null,
        }),
      }),
    ];
  }

  private onUser(
    content: SDKUserMessage["message"]["content"],
    structured: SDKUserMessage["tool_use_result"]
  ): HarnessEvent[] {
    const decoded = decodeToolResults(content);

    if (Option.isNone(decoded)) return [];
    const results = present(decoded.value);

    // The SDK attaches one structured result per message; trust it only when unambiguous.
    const only = results.length === 1 ? structured : null;

    return results.flatMap((block) => this.onToolResult(block, only));
  }

  /** One tool call's result: its final item, and the end of a foreground Subagent it ran. */
  private onToolResult(
    block: ToolResult,
    structured: SDKUserMessage["tool_use_result"]
  ): HarnessEvent[] {
    const id = block.tool_use_id;
    const tool = this.tools.get(id);

    if (!tool) return [];
    this.tools.delete(id);

    if (tool.name === "TodoWrite") return [];

    const status: ToolStatus = this.declined.delete(id)
      ? "declined"
      : block.is_error === true
        ? "failed"
        : "completed";

    this.replies.requested(tool.scope.subagentId ?? "", this.nowMs());

    const completed = ItemCompleted({
      ...scoped(tool.scope),
      item: toolItem({
        id,
        name: tool.name,
        input: tool.input,
        cwd: this.cwd,
        status,
        resultText: toolResultText(block.content),
        structured,
      }),
    });

    // A foreground Subagent ends with its Agent call; a background one with its notification.
    if (this.subagents.get(id)?.background !== false) return [completed];

    return [completed, ...this.endSubagent(id, status === "completed" ? "completed" : "failed")];
  }
}
