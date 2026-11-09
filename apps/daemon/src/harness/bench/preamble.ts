import { TurnItem, type TurnId } from "@polaris/protocol";
import { Effect, Schema } from "effect";
import { polarisPreamble, sessionAttachments } from "../../constellation/skills/preamble.ts";
import type { OpenOptions } from "../HarnessDriver.ts";

export const isPreambleProbe = (prompt: string) =>
  prompt.trim().toLowerCase() === "create a test constellation";

/** Deterministic instruction-delivery probe, not a live Model comprehension evaluation. */
export const preambleProbe = Effect.fnUntraced(function* (options: OpenOptions, turnId: TurnId) {
  const text = polarisPreamble(options);
  const match = /Call (mcp__polaris(?:_\d+)?__plan) with start/.exec(text);
  const attachments = sessionAttachments(options);
  const attached = attachments.find((a) => a.tools.some((tool) => tool.name === "plan"));
  const workspaceId = /workspaceId: ([^\s}]+)/.exec(attached?.instructions ?? "")?.[1];
  const plan = attached?.tools.find((tool) => tool.name === "plan");

  if (match === null || workspaceId === undefined || plan === undefined)
    return TurnItem.cases.AssistantMessage.make({
      id: `${turnId}-preamble`,
      text: "No start tool and workspace were supplied by the Polaris instructions.",
    });

  const input = { start: { name: "Test constellation", workspaceId }, operations: [] };
  const result = yield* Effect.promise(() => plan.call(input));

  return TurnItem.cases.ToolCall.make({
    id: `${turnId}-preamble`,
    name: match[1]!,
    input,
    output: { content: result.content, isError: result.isError ?? false },
    status: result.isError === true ? "failed" : "completed",
  });
});

const ToolInput = Schema.fromJsonString(Schema.JsonObject);

const TOOL_PROBE = /^polaris tool (\S+) (\{.*\})$/s;

/** `polaris tool <name> <json>`: calls one attached Polaris tool, for served-Daemon tests. */
export const isToolProbe = (prompt: string) => TOOL_PROBE.test(prompt.trim());

export const toolProbe = Effect.fnUntraced(function* (
  options: OpenOptions,
  turnId: TurnId,
  prompt: string
) {
  const [, name = "", json = "{}"] = TOOL_PROBE.exec(prompt.trim()) ?? [];
  const input = Schema.decodeUnknownSync(ToolInput)(json);

  const tool = sessionAttachments(options)
    .flatMap((attachment) => attachment.tools)
    .find((candidate) => candidate.name === name);

  if (tool === undefined)
    return TurnItem.cases.AssistantMessage.make({
      id: `${turnId}-tool`,
      text: `No Polaris tool named ${name}.`,
    });

  const result = yield* Effect.promise(() => tool.call(input));

  return TurnItem.cases.ToolCall.make({
    id: `${turnId}-tool`,
    name,
    input,
    output: { content: result.content, isError: result.isError ?? false },
    status: result.isError === true ? "failed" : "completed",
  });
});
