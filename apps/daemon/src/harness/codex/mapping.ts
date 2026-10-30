/**
 * Pure translations between Polaris's Harness vocabulary and the Codex
 * app-server protocol. No I/O here, so every rule is unit-testable.
 */
import {
  ApprovalDecision,
  type Attachment,
  type PermissionMode,
  TurnItem,
} from "@polaris/protocol";
import { Match, Option, Schema } from "effect";
import type * as Gen from "./generated/index.ts";
import type * as P from "./protocol.ts";

// ---------------------------------------------------------------------------
// Permission modes

export interface CodexPolicy {
  readonly approvalPolicy: Gen.AskForApproval;
  readonly approvalsReviewer: Gen.ApprovalsReviewer;
  /** For `thread/start` and `thread/resume`. */
  readonly sandbox: Gen.SandboxMode;
}

/**
 * Polaris permission mode → Codex approval policy, reviewer and sandbox.
 *
 * | mode        | approvalPolicy | approvalsReviewer | sandbox            |
 * |-------------|----------------|-------------------|--------------------|
 * | plan        | untrusted      | user              | read-only          |
 * | supervised  | untrusted      | user              | read-only          |
 * | auto-edits  | on-request     | user              | workspace-write    |
 * | auto        | on-request     | auto_review       | workspace-write    |
 * | full-access | never          | user              | danger-full-access |
 *
 * Same table as T3 Code's runtime modes (design followed, no code copied). `plan` also sets
 * Codex's plan collaboration mode (`collaboration.ts`).
 */
export const policyFor = (mode: PermissionMode, readOnly = false): CodexPolicy => {
  if (readOnly) return { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "read-only" };

  switch (mode) {
    case "plan":
    case "supervised":
      return { approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "read-only" };
    case "auto-edits":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
      };
    case "auto":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandbox: "workspace-write",
      };
    case "full-access":
      return { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access" };
  }
};

/** `turn/start` takes a full sandbox policy rather than a mode; this is the mode's default. */
export const sandboxPolicyFor = (mode: Gen.SandboxMode): Gen.SandboxPolicy => {
  switch (mode) {
    case "read-only":
      return { type: "readOnly", networkAccess: false };
    case "workspace-write":
      return {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
  }
};

// ---------------------------------------------------------------------------
// Turn input

/**
 * Images go to Codex as `localImage` inputs pointing at the staged Host path.
 * Other files are mentioned by path in the prompt, which Codex can read itself.
 */
export const turnInput = (
  prompt: string,
  attachments: ReadonlyArray<Attachment>
): Array<Gen.UserInput> => {
  const images = attachments.filter((a) => a.mimeType.startsWith("image/"));
  const files = attachments.filter((a) => !a.mimeType.startsWith("image/"));

  const text =
    files.length === 0
      ? prompt
      : `${prompt}\n\nAttached files:\n${files.map((f) => `- ${f.hostPath}`).join("\n")}`;

  const pictures = images.map((image): Gen.UserInput => ({
    type: "localImage",
    path: image.hostPath,
  }));

  // An images-only message sends no empty text input.
  return text === "" && pictures.length > 0
    ? pictures
    : [{ type: "text", text, text_elements: [] }, ...pictures];
};

// ---------------------------------------------------------------------------
// Items

const { AssistantMessage, CommandExecution, FileChange, Plan, Reasoning, ToolCall } =
  TurnItem.cases;

const itemStatus = (
  status: "inProgress" | "completed" | "failed" | "declined"
): "running" | "completed" | "failed" | "declined" =>
  status === "inProgress" ? "running" : status;

const collabStatus = (status: string) =>
  Match.value(status).pipe(
    Match.when("inProgress", () => "running" as const),
    Match.when("failed", () => "failed" as const),
    Match.orElse(() => "completed" as const)
  );

type ItemMapper = (item: P.ThreadItem) => TurnItem | null;

/** One mapper per Codex item type; each checks the fields it needs (unknown items share a type). */
const itemMappers = new Map<string, ItemMapper>([
  [
    "agentMessage",
    (item) => ("text" in item ? AssistantMessage.make({ id: item.id, text: item.text }) : null),
  ],
  [
    "plan",
    (item) => ("text" in item ? AssistantMessage.make({ id: item.id, text: item.text }) : null),
  ],
  [
    "reasoning",
    (item) =>
      "summary" in item
        ? Reasoning.make({
            id: item.id,
            text: (item.summary.length > 0 ? item.summary : item.content).join("\n\n"),
            startedAt: null,
            endedAt: null,
          })
        : null,
  ],
  [
    "commandExecution",
    (item) =>
      "command" in item
        ? CommandExecution.make({
            id: item.id,
            command: item.command,
            cwd: item.cwd,
            output: item.aggregatedOutput ?? "",
            exitCode: item.exitCode,
            status: itemStatus(item.status),
          })
        : null,
  ],
  [
    "fileChange",
    (item) =>
      "changes" in item
        ? FileChange.make({
            id: item.id,
            changes: item.changes.map((change) => ({
              path: change.path,
              kind: change.kind.type === "update" ? "modify" : change.kind.type,
            })),
            status: itemStatus(item.status),
          })
        : null,
  ],
  [
    "mcpToolCall",
    (item) =>
      "server" in item
        ? ToolCall.make({
            id: item.id,
            name: `${item.server}.${item.tool}`,
            kind: "mcp",
            mcp: { server: item.server, tool: item.tool },
            input: item.arguments,
            output: item.error ?? item.result,
            status: itemStatus(item.status),
          })
        : null,
  ],
  [
    "dynamicToolCall",
    (item) =>
      "contentItems" in item
        ? ToolCall.make({
            id: item.id,
            name: item.tool,
            kind: "other",
            input: item.arguments,
            output: item.contentItems,
            status: itemStatus(item.status),
          })
        : null,
  ],
  [
    "collabAgentToolCall",
    (item) =>
      "prompt" in item
        ? ToolCall.make({
            id: item.id,
            name: `agent.${item.tool}`,
            kind: "other",
            input: { prompt: item.prompt },
            output: null,
            status: collabStatus(item.status),
          })
        : null,
  ],
  [
    // The spawn (its id is the spawning call's), so the Subagent's card can sit where it began.
    "subAgentActivity",
    (item) =>
      "agentPath" in item && item.kind === "started"
        ? ToolCall.make({
            id: item.id,
            name: "agent.spawn",
            kind: "other",
            input: { agent: item.agentPath },
            output: null,
            status: "completed",
          })
        : null,
  ],
  [
    "webSearch",
    (item) =>
      "query" in item
        ? ToolCall.make({
            id: item.id,
            name: "web_search",
            kind: "web-search",
            input: { query: item.query },
            output: null,
            status: "completed",
          })
        : null,
  ],
  [
    "imageView",
    (item) =>
      "path" in item
        ? ToolCall.make({
            id: item.id,
            name: "view_image",
            kind: "read",
            input: { path: item.path },
            output: null,
            status: "completed",
          })
        : null,
  ],
]);

/** Codex thread item → Polaris Turn item; null for items Polaris doesn't show (user messages…). */
export const toTurnItem = (item: P.ThreadItem): TurnItem | null =>
  itemMappers.get(item.type)?.(item) ?? null;

/** The text of a user message item (its text inputs, in order); null when it has none. */
export const userMessageText = (item: P.ThreadItem): string | null => {
  if (item.type !== "userMessage" || !("content" in item)) return null;

  const text = item.content
    .flatMap((input) => (input.type === "text" && input.text !== undefined ? [input.text] : []))
    .join("\n");

  return text === "" ? null : text;
};

export const toPlanItem = (
  id: string,
  update: Pick<typeof P.TurnPlanUpdatedNotification.Type, "plan" | "explanation">
): TurnItem => {
  const explanation = update.explanation?.trim() ?? "";

  return Plan.make({
    id,
    steps: update.plan.map((step) => ({
      text: step.step,
      status: step.status === "inProgress" ? "in-progress" : step.status,
      detail: null,
    })),
    explanation: explanation === "" ? null : explanation,
  });
};

// ---------------------------------------------------------------------------
// Approvals

/** Command and file-change approvals share one decision vocabulary. */
export const approvalDecision = (
  decision: ApprovalDecision
): Gen.FileChangeRequestApprovalResponse =>
  ApprovalDecision.match(decision, {
    Allow: ({ remember }): Gen.FileChangeRequestApprovalResponse => ({
      decision: remember ? "acceptForSession" : "accept",
    }),
    Deny: (): Gen.FileChangeRequestApprovalResponse => ({ decision: "decline" }),
    Answer: (): Gen.FileChangeRequestApprovalResponse => ({ decision: "decline" }),
    // Only Secret Requests take Provided, and no Harness asks one: decline.
    Provided: (): Gen.FileChangeRequestApprovalResponse => ({ decision: "decline" }),
  });

export const permissionsDecision = (
  requested: (typeof P.PermissionsApprovalParams.Type)["permissions"],
  decision: ApprovalDecision
): P.PermissionsGrant => {
  if (!ApprovalDecision.guards.Allow(decision)) return { permissions: {}, scope: "turn" };
  const granted: P.GrantedPermissions = {};

  if (requested.network !== null) granted.network = requested.network;

  if (requested.fileSystem !== null) granted.fileSystem = requested.fileSystem;

  return { permissions: granted, scope: decision.remember ? "session" : "turn" };
};

/**
 * An answer fills each question with its own answer, or every question with the text;
 * Allow picks each question's first option; Deny answers nothing (a dismissal to Codex).
 */
export const userInputDecision = (
  questions: (typeof P.UserInputParams.Type)["questions"],
  decision: ApprovalDecision
): Gen.ToolRequestUserInputResponse => {
  const answers: Record<string, { answers: Array<string> }> = {};

  for (const [i, question] of questions.entries()) {
    if (ApprovalDecision.guards.Answer(decision)) {
      const own = decision.answers?.[i];
      answers[question.id] = {
        answers: own !== undefined && own.length > 0 ? [...own] : [decision.text],
      };
    } else if (ApprovalDecision.guards.Allow(decision) && question.options?.[0])
      answers[question.id] = { answers: [question.options[0].label] };
  }

  return { answers };
};

export const elicitationDecision = (
  decision: ApprovalDecision
): Gen.McpServerElicitationRequestResponse =>
  ApprovalDecision.match(decision, {
    Allow: (): Gen.McpServerElicitationRequestResponse => ({
      action: "accept",
      content: {},
      _meta: null,
    }),
    Answer: ({ text }) => ({ action: "accept", content: { answer: text }, _meta: null }),
    Deny: () => ({ action: "decline", content: null, _meta: null }),
    // Only Secret Requests take Provided, and no Harness asks one: decline.
    Provided: () => ({ action: "decline", content: null, _meta: null }),
  });

/** A provider error body, as Codex passes it through in an error's message. */
const ApiErrorBody = Schema.fromJsonString(
  Schema.Struct({ error: Schema.Struct({ message: Schema.String }) })
);

const decodeApiError = Schema.decodeUnknownOption(ApiErrorBody);

/** The model a "model '<id>' is not …" rejection names. */
const REJECTED_MODEL = /model '([^']+)' is not/;

/**
 * An error as a person reads it. Codex forwards the API's JSON body as the
 * message (`{"type":"error","error":{"message":…}}`), so the inner message is
 * taken; a Model the account can't use says so and names what to do.
 */
export const readableError = (message: string): string => {
  const start = message.indexOf("{");

  const inner =
    start === -1
      ? message
      : Option.match(decodeApiError(message.slice(start)), {
          onNone: () => message,
          onSome: (body) => body.error.message,
        });

  const model = REJECTED_MODEL.exec(inner)?.[1];

  return model === undefined
    ? inner
    : `${model} isn't available on this Codex account or plan. Choose another Model. Codex said: ${inner}`;
};
