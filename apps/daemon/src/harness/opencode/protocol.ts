/**
 * Runtime schemas for the `opencode serve` v1 payloads the driver consumes.
 *
 * The types in `generated/` come from the server's own `/doc` OpenAPI; these
 * schemas validate the subset of fields the driver reads, and each is checked
 * against its generated type at compile time (`conforms` below), so a new
 * OpenCode that renames or retypes one of them fails `bun run typecheck`.
 * Unknown fields are ignored on decode. Provider `key` and `options` (which can
 * hold API keys) are never decoded (ADR 0001).
 */
import { Option, Schema } from "effect";
import type * as Gen from "./generated/openapi.ts";

const Metadata = Schema.Record(Schema.String, Schema.Unknown);

/** A received payload as `JSON.parse` left it; each consumer decodes it with its own schema. */
export const Payload = Schema.Unknown;

export type Payload = typeof Payload.Type;

/** One SSE `data:` payload from `GET /event`. */
export const Envelope = Schema.Struct({ type: Schema.String, properties: Schema.Unknown });

export const SessionInfo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  directory: Schema.String,
  parentID: Schema.optional(Schema.String),
});

export const SessionUpdated = Schema.Struct({ sessionID: Schema.String, info: SessionInfo });

const MessageError = Schema.Struct({
  name: Schema.String,
  data: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) })),
});

export const MessageInfo = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  error: Schema.optional(MessageError),
  /** An assistant message's Model; a user message names it in `model` instead. */
  providerID: Schema.optional(Schema.String),
  modelID: Schema.optional(Schema.String),
  /** `true` on the assistant message a compaction writes its summary into. */
  summary: Schema.optional(Schema.Unknown),
});

export const MessageUpdated = Schema.Struct({ sessionID: Schema.String, info: MessageInfo });

const PartTime = Schema.Struct({ start: Schema.Number, end: Schema.optional(Schema.Number) });

const PartBase = {
  id: Schema.String,
  sessionID: Schema.String,
  messageID: Schema.String,
};

export const TextPart = Schema.Struct({
  ...PartBase,
  type: Schema.Literal("text"),
  text: Schema.String,
  synthetic: Schema.optional(Schema.Boolean),
  ignored: Schema.optional(Schema.Boolean),
  time: Schema.optional(PartTime),
});

export const ReasoningPart = Schema.Struct({
  ...PartBase,
  type: Schema.Literal("reasoning"),
  text: Schema.String,
  time: PartTime,
});

const ToolStatePending = Schema.Struct({ status: Schema.Literal("pending"), input: Metadata });

const ToolStateRunning = Schema.Struct({
  status: Schema.Literal("running"),
  input: Metadata,
  metadata: Schema.optional(Metadata),
});

const ToolStateCompleted = Schema.Struct({
  status: Schema.Literal("completed"),
  input: Metadata,
  output: Schema.String,
  metadata: Metadata,
});

const ToolStateError = Schema.Struct({
  status: Schema.Literal("error"),
  input: Metadata,
  error: Schema.String,
  metadata: Schema.optional(Metadata),
});

export const ToolState = Schema.Union([
  ToolStatePending,
  ToolStateRunning,
  ToolStateCompleted,
  ToolStateError,
]);

export type ToolState = typeof ToolState.Type;

export const ToolPart = Schema.Struct({
  ...PartBase,
  type: Schema.Literal("tool"),
  callID: Schema.String,
  tool: Schema.String,
  state: ToolState,
});

export type ToolPart = typeof ToolPart.Type;

export const StepFinishPart = Schema.Struct({
  ...PartBase,
  type: Schema.Literal("step-finish"),
  tokens: Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
    reasoning: Schema.Number,
    cache: Schema.Struct({ read: Schema.Number, write: Schema.Number }),
  }),
});

export type StepFinishPart = typeof StepFinishPart.Type;

/** The user message that asks for a compaction: `/compact` (`auto: false`) or a full window. */
export const CompactionPart = Schema.Struct({
  ...PartBase,
  type: Schema.Literal("compaction"),
  auto: Schema.Boolean,
});

/** The parts the driver maps; every other part type decodes to none and is skipped. */
export const Part = Schema.Union([
  TextPart,
  ReasoningPart,
  ToolPart,
  StepFinishPart,
  CompactionPart,
]);

export type Part = typeof Part.Type;

export const PartUpdated = Schema.Struct({ sessionID: Schema.String, part: Schema.Unknown });

export const PartDelta = Schema.Struct({
  sessionID: Schema.String,
  messageID: Schema.String,
  partID: Schema.String,
  field: Schema.String,
  delta: Schema.String,
});

export const SessionStatus = Schema.Struct({
  type: Schema.Literals(["idle", "busy", "retry"]),
  message: Schema.optional(Schema.String),
});

export const SessionStatusChanged = Schema.Struct({
  sessionID: Schema.String,
  status: SessionStatus,
});

export const SessionStatusMap = Schema.Record(Schema.String, SessionStatus);

export const SessionIdle = Schema.Struct({ sessionID: Schema.String });

/**
 * `session.compacted`: the summary is written. Not in `generated/`: written from the
 * `@opencode-ai/sdk` 1.18.33 types (`EventSessionCompacted`).
 */
export const SessionCompacted = Schema.Struct({ sessionID: Schema.String });

export const SessionError = Schema.Struct({
  sessionID: Schema.optional(Schema.String),
  error: Schema.optional(MessageError),
});

export const PermissionRequest = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  permission: Schema.String,
  patterns: Schema.Array(Schema.String),
  metadata: Metadata,
  always: Schema.Array(Schema.String),
});

export type PermissionRequest = typeof PermissionRequest.Type;

export const PermissionReplied = Schema.Struct({
  sessionID: Schema.String,
  requestID: Schema.String,
  reply: Schema.Literals(["once", "always", "reject"]),
});

export const QuestionRequest = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  questions: Schema.Array(
    Schema.Struct({
      question: Schema.String,
      header: Schema.String,
      options: Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String })),
      multiple: Schema.optional(Schema.Boolean),
    })
  ),
});

export type QuestionRequest = typeof QuestionRequest.Type;

export const QuestionResolved = Schema.Struct({
  sessionID: Schema.String,
  requestID: Schema.String,
});

export const ProviderModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.optional(Schema.Literals(["alpha", "beta", "deprecated", "active"])),
  variants: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  limit: Schema.optional(Schema.Struct({ context: Schema.Number })),
});

export const ConfigProviders = Schema.Struct({
  providers: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      models: Schema.Record(Schema.String, ProviderModel),
    })
  ),
  default: Schema.Record(Schema.String, Schema.String),
});

export type ConfigProviders = typeof ConfigProviders.Type;

const OptionalString = Schema.optional(Schema.String);

/** The tool inputs and metadata the driver reads; each tool's own shape, decoded leniently. */
export const BashInput = Schema.Struct({ command: OptionalString, workdir: OptionalString });

export const BashMetadata = Schema.Struct({
  output: OptionalString,
  exit: Schema.optional(Schema.NullOr(Schema.Int)),
});

export const FileInput = Schema.Struct({ filePath: OptionalString, patchText: OptionalString });

export const WriteMetadata = Schema.Struct({ exists: Schema.optional(Schema.Boolean) });

export const TodoInput = Schema.Struct({
  todos: Schema.Array(Schema.Struct({ content: Schema.String, status: Schema.String })),
});

export const PermissionMetadata = Schema.Struct({
  command: OptionalString,
  description: OptionalString,
  filepath: OptionalString,
  diff: OptionalString,
});

export const Config = Schema.Struct({ model: Schema.optional(Schema.NullOr(Schema.String)) });

/** A lenient decoder: none when the payload doesn't match. */
export const decoder = <S extends Schema.Decoder<unknown>>(schema: S) => {
  const decode = Schema.decodeUnknownOption(schema);

  return (input: Payload): S["Type"] | null => Option.getOrNull(decode(input));
};

// ---------------------------------------------------------------------------
// Compile-time conformance with the generated types

type Conforms<Generated, S extends { readonly Type: unknown }> = [Generated] extends [S["Type"]]
  ? true
  : false;

type PartOf<T extends Gen.Part["type"]> = Extract<Gen.Part, { type: T }>;

const conforms = <_ extends true>() => undefined;

conforms<Conforms<Gen.Session, typeof SessionInfo>>();

conforms<Conforms<Gen.EventSessionUpdated["properties"], typeof SessionUpdated>>();

conforms<Conforms<Gen.EventMessageUpdated["properties"], typeof MessageUpdated>>();

conforms<Conforms<PartOf<"text">, typeof TextPart>>();

conforms<Conforms<PartOf<"reasoning">, typeof ReasoningPart>>();

conforms<Conforms<PartOf<"tool">, typeof ToolPart>>();

conforms<Conforms<PartOf<"step-finish">, typeof StepFinishPart>>();

conforms<Conforms<PartOf<"compaction">, typeof CompactionPart>>();

conforms<Conforms<Gen.EventMessagePartUpdated["properties"], typeof PartUpdated>>();

conforms<Conforms<Gen.EventMessagePartDelta["properties"], typeof PartDelta>>();

conforms<Conforms<Gen.EventSessionStatus["properties"], typeof SessionStatusChanged>>();

conforms<Conforms<Gen.EventSessionIdle["properties"], typeof SessionIdle>>();

conforms<Conforms<Gen.EventPermissionAsked["properties"], typeof PermissionRequest>>();

conforms<Conforms<Gen.EventPermissionReplied["properties"], typeof PermissionReplied>>();

conforms<Conforms<Gen.EventQuestionAsked["properties"], typeof QuestionRequest>>();

conforms<Conforms<Gen.EventQuestionReplied["properties"], typeof QuestionResolved>>();

conforms<Conforms<Gen.EventQuestionRejected["properties"], typeof QuestionResolved>>();

conforms<Conforms<Gen.ConfigProvidersResponse, typeof ConfigProviders>>();

/**
 * `GET /command`: the commands OpenCode offers in a directory. Not in
 * `generated/`: written from opencode 1.15.5's `/doc`, as the field names there.
 */
export const Command = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "mcp", "skill"])),
  template: Schema.String,
  hints: Schema.Array(Schema.String),
});

export const Commands = Schema.Array(Command);

/** `POST /session/{id}/command`: runs a command, expanding its template, as OpenCode's TUI does. */
export interface CommandBody {
  command: string;
  arguments: string;
  model?: string;
  variant?: string;
  agent?: string;
}

/**
 * `POST /session/{id}/summarize`: compacts the session with this Model; answers `true` once
 * the summary is written. Not in `generated/`: from the `@opencode-ai/sdk` 1.18.33 types.
 */
export interface SummarizeBody {
  providerID: string;
  modelID: string;
  auto?: boolean;
}

/** Wire shapes the driver sends; typed against the generated request bodies. */
export type SessionCreateBody = Gen.SessionCreateBody;

export type SessionUpdateBody = Gen.SessionUpdateBody;

export type PromptAsyncBody = Gen.PromptAsyncBody;

export type PermissionReplyBody = Gen.PermissionReplyBody;

export type QuestionReplyBody = Gen.QuestionReplyBody;

export type PermissionRuleset = Gen.PermissionRuleset;

/** Every body the driver sends. */
export type Outgoing =
  | CommandBody
  | SummarizeBody
  | SessionCreateBody
  | SessionUpdateBody
  | PromptAsyncBody
  | PermissionReplyBody
  | QuestionReplyBody;
