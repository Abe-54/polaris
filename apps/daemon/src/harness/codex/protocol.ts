/**
 * Runtime schemas for the Codex app-server messages the driver consumes.
 *
 * The TypeScript bindings in `generated/` come straight from
 * `codex app-server generate-ts`; these schemas validate the subset of fields
 * the driver reads. Each schema is checked against its generated type at
 * compile time (`Conforms` below), so regenerating against a Codex version that
 * renames or retypes a field the driver relies on fails `bun run typecheck`.
 * Unknown fields are ignored on decode, so additive protocol changes are safe.
 */
import { Schema } from "effect";
import type * as Gen from "./generated/index.ts";

const NullableString = Schema.NullOr(Schema.String);

const OptionalNullableString = Schema.optional(NullableString);

export const RpcId = Schema.Union([Schema.String, Schema.Number]);

export type RpcId = typeof RpcId.Type;

/** A JSON-RPC payload (`params`, `result`) the driver sends. */
export type Json = Schema.Json;

/**
 * A received payload, as `JSON.parse` left it: each method's handler decodes it with its
 * own schema, so the frame isn't walked twice (it runs once per streamed delta).
 */
export const RpcPayload = Schema.Unknown;

export type RpcPayload = typeof RpcPayload.Type;

/** One JSON-RPC message as it arrives on the wire (`"jsonrpc"` is omitted by app-server). */
export const RpcMessage = Schema.Struct({
  id: Schema.optional(RpcId),
  method: Schema.optional(Schema.String),
  params: Schema.optional(RpcPayload),
  result: Schema.optional(RpcPayload),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.Number,
      message: Schema.String,
      data: Schema.optional(RpcPayload),
    })
  ),
});

export type RpcMessage = typeof RpcMessage.Type;

// ---------------------------------------------------------------------------
// Thread items

const ItemStatus = Schema.Literals(["inProgress", "completed", "failed", "declined"]);

export const AgentMessageItem = Schema.Struct({
  type: Schema.Literal("agentMessage"),
  id: Schema.String,
  text: Schema.String,
  /** `"async"` marks a message the user may answer later with a new user message. */
  delivery: Schema.optional(Schema.NullOr(Schema.Literal("async"))),
  questions: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          title: Schema.String,
          options: Schema.NullOr(Schema.Array(Schema.String)),
        })
      )
    )
  ),
});

export const PlanItem = Schema.Struct({
  type: Schema.Literal("plan"),
  id: Schema.String,
  text: Schema.String,
});

export const ReasoningItem = Schema.Struct({
  type: Schema.Literal("reasoning"),
  id: Schema.String,
  summary: Schema.Array(Schema.String),
  content: Schema.Array(Schema.String),
});

export const CommandExecutionItem = Schema.Struct({
  type: Schema.Literal("commandExecution"),
  id: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  status: ItemStatus,
  aggregatedOutput: NullableString,
  exitCode: Schema.NullOr(Schema.Number),
  /** The process behind it, which can outlive its Turn (a unified exec session). */
  processId: Schema.optional(Schema.NullOr(Schema.String)),
});

export const FileChangeItem = Schema.Struct({
  type: Schema.Literal("fileChange"),
  id: Schema.String,
  changes: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      kind: Schema.Struct({ type: Schema.Literals(["add", "delete", "update"]) }),
    })
  ),
  status: ItemStatus,
});

export const McpToolCallItem = Schema.Struct({
  type: Schema.Literal("mcpToolCall"),
  id: Schema.String,
  server: Schema.String,
  tool: Schema.String,
  status: Schema.Literals(["inProgress", "completed", "failed"]),
  arguments: Schema.Unknown,
  result: Schema.NullOr(Schema.Unknown),
  error: Schema.NullOr(Schema.Unknown),
});

export const DynamicToolCallItem = Schema.Struct({
  type: Schema.Literal("dynamicToolCall"),
  id: Schema.String,
  tool: Schema.String,
  arguments: Schema.Unknown,
  status: Schema.Literals(["inProgress", "completed", "failed"]),
  contentItems: Schema.NullOr(Schema.Unknown),
});

export const CollabAgentToolCallItem = Schema.Struct({
  type: Schema.Literal("collabAgentToolCall"),
  id: Schema.String,
  tool: Schema.String,
  status: Schema.String,
  prompt: NullableString,
  /** For `spawnAgent`: the new agents' threads (each one a Subagent). */
  receiverThreadIds: Schema.Array(Schema.String),
  model: NullableString,
  /** The last known status of each agent it addressed, by thread id. */
  agentsStates: Schema.Record(
    Schema.String,
    Schema.UndefinedOr(Schema.Struct({ status: Schema.String }))
  ),
});

/** Multi-agent v2: an agent (a Subagent) started, was addressed, stopped or finished. */
export const SubAgentActivityItem = Schema.Struct({
  type: Schema.Literal("subAgentActivity"),
  id: Schema.String,
  kind: Schema.Literals(["started", "interacted", "interrupted", "completed"]),
  agentThreadId: Schema.String,
  /** Where it sits in the agent tree, ending with its name (`/root/pong`). */
  agentPath: Schema.String,
});

export const WebSearchItem = Schema.Struct({
  type: Schema.Literal("webSearch"),
  id: Schema.String,
  query: Schema.String,
});

export const ImageViewItem = Schema.Struct({
  type: Schema.Literal("imageView"),
  id: Schema.String,
  path: Schema.String,
});

/** What the user typed; gives Turns started in the TUI their prompt. */
export const UserMessageItem = Schema.Struct({
  type: Schema.Literal("userMessage"),
  id: Schema.String,
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })
  ),
});

/** Anything else (compaction markers, review mode…); the driver skips these. */
export const OtherItem = Schema.Struct({ type: Schema.String, id: Schema.optional(Schema.String) });

export const ThreadItem = Schema.Union([
  UserMessageItem,
  AgentMessageItem,
  PlanItem,
  ReasoningItem,
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  DynamicToolCallItem,
  CollabAgentToolCallItem,
  SubAgentActivityItem,
  WebSearchItem,
  ImageViewItem,
  OtherItem,
]);

export type ThreadItem = typeof ThreadItem.Type;

// ---------------------------------------------------------------------------
// Responses

/** `initialize`: the user agent names the app-server's codex version. */
export const InitializeResponse = Schema.Struct({ userAgent: Schema.String });

export const ThreadResponse = Schema.Struct({
  thread: Schema.Struct({ id: Schema.String }),
  /** The Model the thread runs on; a collaboration mode needs it. */
  model: Schema.optionalKey(Schema.String),
  /** On resume: the thread's collaboration mode, `plan` when it was planning. */
  collaborationMode: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ mode: Schema.Literals(["plan", "default"]) }))
  ),
});

export const TurnStartResponse = Schema.Struct({ turn: Schema.Struct({ id: Schema.String }) });

/** `model/list`: one page of the Models Codex offers. */
export const ModelListResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      /** What `turn/start` takes as `model`. */
      model: Schema.String,
      displayName: Schema.String,
      description: Schema.String,
      hidden: Schema.Boolean,
      supportedReasoningEfforts: Schema.Array(Schema.Struct({ reasoningEffort: Schema.String })),
      defaultReasoningEffort: Schema.String,
      isDefault: Schema.Boolean,
    })
  ),
  nextCursor: NullableString,
});

export const TurnSteerResponse = Schema.Struct({ turnId: Schema.String });

/** `review/start`: the Turn the review runs in. */
export const ReviewStartResponse = Schema.Struct({ turn: Schema.Struct({ id: Schema.String }) });

/** `skills/list`: the Skills Codex finds for each directory asked about. */
export const SkillsListResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      cwd: Schema.String,
      skills: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          description: Schema.String,
          shortDescription: Schema.optional(Schema.String),
          path: Schema.String,
          scope: Schema.Literals(["user", "repo", "system", "admin"]),
          enabled: Schema.Boolean,
          pluginId: NullableString,
        })
      ),
    })
  ),
});

export const ThreadLoadedListResponse = Schema.Struct({
  data: Schema.optional(Schema.Array(Schema.String)),
});

// ---------------------------------------------------------------------------
// Notifications

const TurnStatus = Schema.Literals(["completed", "interrupted", "failed", "inProgress"]);

const TurnError = Schema.Struct({
  message: Schema.String,
  /** A string for the plain kinds (`usageLimitExceeded`), an object for HTTP ones. */
  codexErrorInfo: Schema.optional(Schema.NullOr(Schema.Unknown)),
});

export const TurnStartedNotification = Schema.Struct({
  threadId: Schema.String,
  turn: Schema.Struct({ id: Schema.String, status: TurnStatus }),
});

export const TurnCompletedNotification = Schema.Struct({
  threadId: Schema.String,
  turn: Schema.Struct({
    id: Schema.String,
    status: TurnStatus,
    error: Schema.NullOr(TurnError),
  }),
});

export const ItemNotification = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  item: ThreadItem,
  /** When the item started (`item/started`) or completed (`item/completed`), in Unix ms. */
  startedAtMs: Schema.optional(Schema.Number),
  completedAtMs: Schema.optional(Schema.Number),
});

export const DeltaNotification = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  itemId: Schema.String,
  delta: Schema.String,
});

export const TurnPlanUpdatedNotification = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  explanation: OptionalNullableString,
  plan: Schema.Array(
    Schema.Struct({
      step: Schema.String,
      status: Schema.Literals(["pending", "inProgress", "completed"]),
    })
  ),
});

const TokenUsageBreakdown = Schema.Struct({
  totalTokens: Schema.Number,
  /** Reasoning included (`reasoningOutputTokens` is its share). */
  outputTokens: Schema.Number,
});

export const ThreadTokenUsageUpdatedNotification = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  tokenUsage: Schema.Struct({
    last: TokenUsageBreakdown,
    modelContextWindow: Schema.NullOr(Schema.Number),
  }),
});

export const ServerRequestResolvedNotification = Schema.Struct({
  threadId: Schema.String,
  requestId: RpcId,
});

export const ErrorNotification = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  willRetry: Schema.Boolean,
  error: TurnError,
});

export const ThreadNameUpdatedNotification = Schema.Struct({
  threadId: Schema.String,
  threadName: Schema.optional(Schema.String),
});

// ---------------------------------------------------------------------------
// Server → client requests

export const CommandApprovalParams = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  itemId: Schema.String,
  reason: OptionalNullableString,
  command: OptionalNullableString,
  cwd: OptionalNullableString,
});

export const FileChangeApprovalParams = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  itemId: Schema.String,
  reason: OptionalNullableString,
  grantRoot: OptionalNullableString,
});

export const PermissionsApprovalParams = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  itemId: Schema.String,
  reason: NullableString,
  permissions: Schema.Struct({
    network: Schema.NullOr(Schema.Json),
    fileSystem: Schema.NullOr(Schema.Json),
  }),
});

export const UserInputParams = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  itemId: Schema.String,
  questions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      header: Schema.String,
      question: Schema.String,
      options: Schema.NullOr(
        Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String }))
      ),
    })
  ),
});

export const ElicitationParams = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  serverName: Schema.String,
  mode: Schema.String,
  message: Schema.String,
});

// ---------------------------------------------------------------------------
// Compile-time conformance with the generated bindings

type Conforms<Generated, S extends { readonly Type: unknown }> = [Generated] extends [S["Type"]]
  ? true
  : false;

type Item<T extends Gen.ThreadItem["type"]> = Extract<Gen.ThreadItem, { type: T }>;

const conforms = <_ extends true>() => undefined;

conforms<Conforms<Item<"userMessage">, typeof UserMessageItem>>();

conforms<Conforms<Item<"agentMessage">, typeof AgentMessageItem>>();

conforms<Conforms<Item<"plan">, typeof PlanItem>>();

conforms<Conforms<Item<"reasoning">, typeof ReasoningItem>>();

conforms<Conforms<Item<"commandExecution">, typeof CommandExecutionItem>>();

conforms<Conforms<Item<"fileChange">, typeof FileChangeItem>>();

conforms<Conforms<Item<"mcpToolCall">, typeof McpToolCallItem>>();

conforms<Conforms<Item<"dynamicToolCall">, typeof DynamicToolCallItem>>();

conforms<Conforms<Item<"collabAgentToolCall">, typeof CollabAgentToolCallItem>>();

conforms<Conforms<Item<"subAgentActivity">, typeof SubAgentActivityItem>>();

conforms<Conforms<Item<"webSearch">, typeof WebSearchItem>>();

conforms<Conforms<Item<"imageView">, typeof ImageViewItem>>();

conforms<Conforms<Gen.InitializeResponse, typeof InitializeResponse>>();

conforms<Conforms<Gen.ThreadStartResponse, typeof ThreadResponse>>();

conforms<Conforms<Gen.ThreadResumeResponse, typeof ThreadResponse>>();

conforms<Conforms<Gen.TurnStartResponse, typeof TurnStartResponse>>();

conforms<Conforms<Gen.ModelListResponse, typeof ModelListResponse>>();

conforms<Conforms<Gen.TurnSteerResponse, typeof TurnSteerResponse>>();

conforms<Conforms<Gen.ReviewStartResponse, typeof ReviewStartResponse>>();

conforms<Conforms<Gen.SkillsListResponse, typeof SkillsListResponse>>();

conforms<Conforms<Gen.TurnStartedNotification, typeof TurnStartedNotification>>();

conforms<Conforms<Gen.TurnCompletedNotification, typeof TurnCompletedNotification>>();

conforms<Conforms<Gen.ItemStartedNotification, typeof ItemNotification>>();

conforms<Conforms<Gen.ItemCompletedNotification, typeof ItemNotification>>();

conforms<Conforms<Gen.AgentMessageDeltaNotification, typeof DeltaNotification>>();

conforms<Conforms<Gen.PlanDeltaNotification, typeof DeltaNotification>>();

conforms<Conforms<Gen.ReasoningSummaryTextDeltaNotification, typeof DeltaNotification>>();

conforms<Conforms<Gen.ReasoningTextDeltaNotification, typeof DeltaNotification>>();

conforms<Conforms<Gen.CommandExecutionOutputDeltaNotification, typeof DeltaNotification>>();

conforms<Conforms<Gen.TurnPlanUpdatedNotification, typeof TurnPlanUpdatedNotification>>();

conforms<
  Conforms<Gen.ThreadTokenUsageUpdatedNotification, typeof ThreadTokenUsageUpdatedNotification>
>();

conforms<
  Conforms<Gen.ServerRequestResolvedNotification, typeof ServerRequestResolvedNotification>
>();

conforms<Conforms<Gen.ErrorNotification, typeof ErrorNotification>>();

conforms<Conforms<Gen.ThreadNameUpdatedNotification, typeof ThreadNameUpdatedNotification>>();

type RequestParams<M extends Gen.ServerRequest["method"]> = Extract<
  Gen.ServerRequest,
  { method: M }
>["params"];

conforms<
  Conforms<RequestParams<"item/commandExecution/requestApproval">, typeof CommandApprovalParams>
>();

conforms<
  Conforms<RequestParams<"item/fileChange/requestApproval">, typeof FileChangeApprovalParams>
>();

conforms<
  Conforms<RequestParams<"item/permissions/requestApproval">, typeof PermissionsApprovalParams>
>();

conforms<Conforms<RequestParams<"item/tool/requestUserInput">, typeof UserInputParams>>();

conforms<Conforms<RequestParams<"mcpServer/elicitation/request">, typeof ElicitationParams>>();

/** Wire shapes the driver sends; typed against the generated bindings. */
export type ClientParams = {
  readonly initialize: Gen.InitializeParams;
  readonly "thread/start": Gen.ThreadStartParams;
  readonly "thread/resume": Gen.ThreadResumeParams;
  readonly "thread/unsubscribe": Gen.ThreadUnsubscribeParams;
  readonly "turn/start": Gen.TurnStartParams;
  readonly "turn/steer": Gen.TurnSteerParams;
  readonly "turn/interrupt": Gen.TurnInterruptParams;
  readonly "model/list": Gen.ModelListParams;
  readonly "skills/list": Gen.SkillsListParams;
  readonly "thread/compact/start": Gen.ThreadCompactStartParams;
  readonly "review/start": Gen.ReviewStartParams;
};

/** The permissions a grant gives: parts of the requested profile, as Codex sent them. */
export type GrantedPermissions = { network?: Json; fileSystem?: Json };

/** A permissions grant: exactly the requested profile, forwarded as Codex sent it. */
export type PermissionsGrant = {
  readonly permissions: GrantedPermissions;
  readonly scope: Gen.PermissionsRequestApprovalResponse["scope"];
};

/** Wire shapes the driver answers server requests with. */
export type ServerRequestResponse =
  | Gen.CommandExecutionRequestApprovalResponse
  | Gen.FileChangeRequestApprovalResponse
  | Gen.ToolRequestUserInputResponse
  | Gen.McpServerElicitationRequestResponse
  | PermissionsGrant;

/** A payload the driver writes: typed client params, a server-request response, or plain JSON. */
export type Outgoing = ClientParams[keyof ClientParams] | ServerRequestResponse | Json;
