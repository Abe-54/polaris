/**
 * Effect Schemas for the untyped parts of Claude Code's payloads that the driver
 * reads: Agent SDK content blocks, tool inputs and results, and the bodies of In
 * Terminal hooks. Fields the driver doesn't read are ignored.
 */
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TurnItem } from "@polaris/protocol";
import { Effect, Option, Schema } from "effect";

type ToolCallItem = Extract<TurnItem, { readonly _tag: "ToolCall" }>;

/** A tool's input or structured result as Claude sent it, kept verbatim in a `ToolCall`. */
export type ToolPayload = ToolCallItem["input"];

/** A string field; a missing key, or a value of any other type, reads as null. */
export const StringOrNull = Schema.NullOr(Schema.String).pipe(
  Schema.catchDecoding(() => Effect.succeed(Option.some(null))),
  Schema.withDecodingDefaultKey(Effect.succeed(null))
);

/** A boolean field; a missing key, or a value of any other type, reads as false. */
const FlagOrFalse = Schema.Boolean.pipe(
  Schema.catchDecoding(() => Effect.succeed(Option.some(false))),
  Schema.withDecodingDefaultKey(Effect.succeed(false))
);

/** An array field; elements that don't decode as `item` read as null, anything else as `[]`. */
const lenientArray = <S extends Schema.Top>(item: S) =>
  Schema.Array(
    Schema.NullOr(item).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(null))))
  ).pipe(
    Schema.catchDecoding(() => Effect.succeed(Option.some([]))),
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  );

/** The decoded elements of a `lenientArray`, without the ones that didn't decode. */
export const present = <A>(items: ReadonlyArray<A | null>): ReadonlyArray<A> =>
  items.flatMap((item) => (item === null ? [] : [item]));

// ---------------------------------------------------------------------------
// Agent SDK messages

export const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const ThinkingBlock = Schema.Struct({ type: Schema.Literal("thinking"), thinking: Schema.String });

const ToolUseBlock = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: StringOrNull,
  input: Schema.optional(Schema.Unknown),
});

/** An assistant message's content; blocks of other kinds read as null but keep their index. */
export const decodeAssistantContent = Schema.decodeUnknownOption(
  lenientArray(Schema.Union([TextBlock, ThinkingBlock, ToolUseBlock]))
);

export type AssistantBlock =
  | typeof TextBlock.Type
  | typeof ThinkingBlock.Type
  | typeof ToolUseBlock.Type;

const ToolResultBlock = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.String,
  content: Schema.optional(Schema.Unknown),
  is_error: Schema.optional(Schema.Unknown),
});

/** The `tool_result` blocks of a user message. */
export type ToolResult = typeof ToolResultBlock.Type;

export const decodeToolResults = Schema.decodeUnknownOption(lenientArray(ToolResultBlock));

/** A `tool_result`'s content: a string, or content blocks of which the text ones count. */
export const decodeToolResultContent = Schema.decodeUnknownOption(
  Schema.Union([Schema.String, lenientArray(TextBlock)])
);

// ---------------------------------------------------------------------------
// Tool inputs and results

/** The input fields of the built-in tools the driver describes. */
const ToolFields = Schema.Struct({
  command: StringOrNull,
  description: StringOrNull,
  file_path: StringOrNull,
  notebook_path: StringOrNull,
  edit_mode: StringOrNull,
  url: StringOrNull,
  query: StringOrNull,
  plan: StringOrNull,
  /** On a structured Write result: `create` for a new file. */
  type: StringOrNull,
  stdout: StringOrNull,
  stderr: StringOrNull,
  /** On a Bash result: the background task the command moved to. */
  backgroundTaskId: StringOrNull,
  /** On a Bash result: what a non-zero exit Claude Code didn't count as an error meant. */
  returnCodeInterpretation: StringOrNull,
  /** On a Bash result: the command was interrupted before it exited. */
  interrupted: FlagOrFalse,
  /** On a Bash input: the command started in the background. */
  run_in_background: FlagOrFalse,
  /** The Agent (Task) tool's helper kind and Model override. */
  subagent_type: StringOrNull,
  model: StringOrNull,
  message: StringOrNull,
});

export type ToolFields = typeof ToolFields.Type;

const NO_FIELDS: ToolFields = {
  command: null,
  description: null,
  file_path: null,
  notebook_path: null,
  edit_mode: null,
  url: null,
  query: null,
  plan: null,
  type: null,
  stdout: null,
  stderr: null,
  backgroundTaskId: null,
  returnCodeInterpretation: null,
  interrupted: false,
  run_in_background: false,
  subagent_type: null,
  model: null,
  message: null,
};

const decodeToolFields = Schema.decodeUnknownOption(ToolFields);

/** The fields of a tool input or result; all null when it isn't an object. */
export const toolFields = (payload: ToolPayload): ToolFields =>
  Option.getOrElse(decodeToolFields(payload), () => NO_FIELDS);

/** A result's `modelUsage`: each Model's context window (older CLIs may leave it out). */
const decodeModelUsage = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.Struct({ contextWindow: Schema.Number }))
);

/** The largest context window among the Models a result used: the Turn's own Model. */
export const contextWindowOf = (result: Pick<SDKResultMessage, "modelUsage">): number | null => {
  const usage = decodeModelUsage(result.modelUsage);

  const windows = Option.isSome(usage)
    ? Object.values(usage.value).map((model) => model.contextWindow)
    : [];

  return windows.length === 0 ? null : Math.max(...windows);
};

const Todo = Schema.Struct({
  content: Schema.String,
  status: Schema.Literals(["pending", "in_progress", "completed"]),
  /** The step in the present tense ("Running the tests"), shown while it is the current one. */
  activeForm: StringOrNull,
});

/** TodoWrite's input: its todos, without the ones that don't read as a todo. */
export const decodeTodos = Schema.decodeUnknownOption(Schema.Struct({ todos: lenientArray(Todo) }));

const Question = Schema.Struct({
  question: Schema.String,
  header: StringOrNull,
  options: lenientArray(Schema.Struct({ label: Schema.String, description: StringOrNull })),
  multiSelect: Schema.optional(Schema.Unknown),
});

/** AskUserQuestion's input: its questions, without the ones that don't read as a question. */
export const decodeQuestions = Schema.decodeUnknownOption(
  Schema.Struct({ questions: lenientArray(Question) })
);

// ---------------------------------------------------------------------------
// Hooks

/** The body Claude Code POSTs for a hook event (the fields Polaris reads). */
export const HookBody = Schema.Struct({
  hook_event_name: StringOrNull,
  session_id: StringOrNull,
  /** Set when a subagent, not the main agent, fired the hook. */
  agent_id: StringOrNull,
  cwd: StringOrNull,
  prompt: StringOrNull,
  tool_name: StringOrNull,
  tool_use_id: StringOrNull,
  tool_input: Schema.optional(Schema.Unknown),
  tool_response: Schema.optional(Schema.Unknown),
  error: StringOrNull,
  is_interrupt: Schema.optional(Schema.Unknown),
  notification_type: StringOrNull,
  message: StringOrNull,
  last_assistant_message: StringOrNull,
  transcript_path: StringOrNull,
});

export type HookBody = typeof HookBody.Type;

export const decodeHookBody = Schema.decodeUnknownOption(HookBody);
