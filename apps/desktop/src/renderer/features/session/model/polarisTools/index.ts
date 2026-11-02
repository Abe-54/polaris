/**
 * A Polaris tool call as its row reads it (DESIGN.md, Polaris tools in the conversation): the
 * verb and subject in glossary words, the well it opens to, Polaris's reply, and the raw call.
 */
import type { Schema } from "effect";
import { polarisTool } from "../runs.ts";
import * as inputs from "./inputs.ts";
import { decodeInput } from "./inputs.ts";
import * as lead from "./lead.ts";
import { outputText, parseResult, type ToolResult } from "./result.ts";
import { notify, requestSecret, waitForCommand } from "./session.ts";
import type { Built, PolarisToolView, Refusal, ToolCallItem } from "./types.ts";
import * as visualization from "./visualization.ts";
import * as worker from "./worker.ts";
import { lowerFirst } from "./words.ts";

export { type BannerRecord, withBanner } from "./session.ts";

export type * from "./types.ts";

export {
  revisedAmong,
  revisedBy,
  revisedIds,
  type VisualizationView,
  visualizationTurns,
  visualizationView,
} from "./visualization.ts";

type Builder = (item: ToolCallItem, result: ToolResult | null) => Built;

/** A tool's builder over its input as its schema reads it. */
const tool =
  <S extends Schema.Decoder<object>>(
    schema: S,
    build: (input: S["Type"], result: ToolResult | null) => Built
  ): Builder =>
  (item, result) =>
    build(decodeInput(schema, item), result);

const BUILDERS = new Map<string, Builder>([
  ["plan", tool(inputs.PlanInput, lead.plan)],
  ["dispatch", tool(inputs.DispatchInput, lead.dispatch)],
  ["review", tool(inputs.ReviewInput, lead.review)],
  ["answer", tool(inputs.AnswerInput, lead.answer)],
  ["status", () => lead.status()],
  ["set_state", tool(inputs.SetStateInput, lead.setState)],
  ["read_worker", tool(inputs.ReadWorkerInput, lead.readWorker)],
  ["message", tool(inputs.MessageInput, worker.message)],
  ["block", tool(inputs.BlockInput, worker.block)],
  ["progress", tool(inputs.ProgressInput, worker.progress)],
  ["waiting_on", tool(inputs.WaitingOnInput, worker.waitingOn)],
  ["ask", tool(inputs.AskInput, worker.ask)],
  ["claim", tool(inputs.ClaimInput, worker.claim)],
  ["propose", tool(inputs.ProposeInput, worker.propose)],
  ["wait_for_command", tool(inputs.WaitInput, waitForCommand)],
  ["notify", tool(inputs.NotifyInput, notify)],
  ["visualize", tool(visualization.VisualizeInput, visualization.visualize)],
  ["request_secret", tool(inputs.RequestSecretInput, requestSecret)],
]);

const unknownTool = (name: string): Built => {
  const words = name.replaceAll("_", " ");

  return {
    head: {
      verbs: [`Running ${words}`, `Ran ${words}`, `run ${words}`],
      subject: null,
      detail: [],
      caption: null,
    },
    well: null,
    links: [],
  };
};

/** A refusal's words on the row, where the finding's own message reads as a log line. */
const REFUSAL_DETAIL = new Map([["E-RATE", "too soon after the last one"]]);

const REFUSAL_CAPTION = new Map([
  ["E-RATE", "rate-limited"],
  ["declined", "declined"],
]);

/** A finding Polaris returned, or the Harness's own failure when it never reached Polaris. */
const refusalOf = (item: ToolCallItem, result: ToolResult | null): Refusal | null => {
  if (result?.refusal != null) return result.refusal;

  if (item.status === "declined")
    return { code: "declined", message: "You declined the call", fix: null };

  if (item.status !== "failed") return null;

  const message =
    result === null || result.summary === "" ? "The call didn't reach Polaris" : result.summary;

  return { code: "failed", message, fix: null };
};

const revisionText = (result: ToolResult | null) =>
  result?.revision != null && result.revision > 0 ? ` · revision ${result.revision}` : "";

const noticeOf = (name: string, item: ToolCallItem) => {
  if (name !== "notify") return null;

  const { title = "", body = "" } = decodeInput(inputs.NotifyInput, item);

  return { title, body };
};

/** The row for a Polaris tool call; null for any other tool. */
export const polarisToolView = (item: ToolCallItem): PolarisToolView | null => {
  const name = polarisTool(item.name);

  if (name === null) return null;

  const running = item.status === "running";
  const text = running ? "" : outputText(item);
  const result = running ? null : parseResult(text);
  const refusal = refusalOf(item, result);
  const built = BUILDERS.get(name)?.(item, result) ?? unknownTool(name);
  const { verbs, subject, detail, caption } = built.head;

  const base = {
    tool: name,
    subject,
    links: built.links,
    notice: noticeOf(name, item),
    raw: { name: item.name, input: JSON.stringify(item.input, null, 2) ?? "", output: text },
  };

  if (running)
    return {
      ...base,
      phase: "pending",
      verb: verbs[0],
      detail,
      caption,
      well: null,
      refusal: null,
      reply: null,
    };

  if (refusal !== null)
    return {
      ...base,
      phase: "refused",
      verb: `Didn't ${verbs[2]}`,
      detail: [{ text: REFUSAL_DETAIL.get(refusal.code) ?? lowerFirst(refusal.message) }],
      caption: REFUSAL_CAPTION.get(refusal.code) ?? "rejected",
      well: null,
      refusal,
      reply: `Nothing changed${revisionText(result)}`,
    };

  const summary = (result?.summary ?? "").replace(/\.$/, "");

  return {
    ...base,
    phase: "done",
    verb: verbs[1],
    detail,
    caption,
    well: built.well,
    refusal: null,
    reply: summary === "" ? null : `${summary}${revisionText(result)}`,
  };
};
