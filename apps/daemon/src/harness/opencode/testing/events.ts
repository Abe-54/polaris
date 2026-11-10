/** Builders for the `/event` payloads `opencode serve` sends, for tests. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Payload, ToolState } from "../protocol.ts";

const event = <T extends object>(type: string, properties: T) => ({
  id: `evt_${crypto.randomUUID()}`,
  type,
  properties,
});

export const events = (sessionID: string) => ({
  user: (id: string) =>
    event("message.updated", {
      sessionID,
      info: { id, sessionID, role: "user", time: { created: 0 } },
    }),
  userText: (messageID: string, text: string) =>
    event("message.part.updated", {
      sessionID,
      part: { id: `prt_${messageID}`, sessionID, messageID, type: "text", text },
      time: 0,
    }),
  assistant: (
    id: string,
    extra: {
      readonly providerID?: string;
      readonly modelID?: string;
      readonly summary?: boolean;
    } = {}
  ) =>
    event("message.updated", {
      sessionID,
      info: { id, sessionID, role: "assistant", time: { created: 0 }, ...extra },
    }),
  /** A finished model call carrying `input` (fresh) and `cached` (read) tokens, writing `output`. */
  stepFinish: (messageID: string, tokens: { input: number; cached: number; output: number }) =>
    event("message.part.updated", {
      sessionID,
      part: {
        id: `prt_step_${crypto.randomUUID()}`,
        sessionID,
        messageID,
        type: "step-finish",
        reason: "stop",
        cost: 0,
        tokens: {
          input: tokens.input,
          output: tokens.output,
          reasoning: 0,
          cache: { read: tokens.cached, write: 0 },
        },
      },
      time: 0,
    }),
  /** The user message's part that asks for a compaction. */
  compaction: (messageID: string, auto: boolean) =>
    event("message.part.updated", {
      sessionID,
      part: { id: `prt_${messageID}`, sessionID, messageID, type: "compaction", auto },
      time: 0,
    }),
  compacted: () => event("session.compacted", { sessionID }),
  text: (messageID: string, id: string, text: string, done = true) =>
    event("message.part.updated", {
      sessionID,
      part: {
        id,
        sessionID,
        messageID,
        type: "text",
        text,
        time: done ? { start: 0, end: 1 } : { start: 0 },
      },
      time: 0,
    }),
  reasoning: (messageID: string, id: string, text: string) =>
    event("message.part.updated", {
      sessionID,
      part: { id, sessionID, messageID, type: "reasoning", text, time: { start: 0, end: 1 } },
      time: 0,
    }),
  delta: (messageID: string, partID: string, delta: string) =>
    event("message.part.delta", { sessionID, messageID, partID, field: "text", delta }),
  tool: (messageID: string, id: string, tool: string, state: ToolState) =>
    event("message.part.updated", {
      sessionID,
      part: { id, sessionID, messageID, type: "tool", tool, callID: `call_${id}`, state },
      time: 0,
    }),
  status: (type: "busy" | "idle") => event("session.status", { sessionID, status: { type } }),
  idle: () => event("session.idle", { sessionID }),
  error: (name: string, message?: string) =>
    event("session.error", {
      sessionID,
      error: { name, data: message === undefined ? {} : { message } },
    }),
  title: (title: string) =>
    event("session.updated", {
      sessionID,
      info: {
        id: sessionID,
        title,
        directory: "/repo",
        projectID: "global",
        time: { created: 0, updated: 0 },
      },
    }),
  permission: (id: string, permission: string, patterns: ReadonlyArray<string>, metadata = {}) =>
    event("permission.asked", { id, sessionID, permission, patterns, metadata, always: [] }),
  permissionReplied: (requestID: string, reply: "once" | "always" | "reject") =>
    event("permission.replied", { sessionID, requestID, reply }),
  question: (
    id: string,
    questions: ReadonlyArray<{ question: string; options: ReadonlyArray<string> }>
  ) =>
    event("question.asked", {
      id,
      sessionID,
      questions: questions.map((q) => ({
        question: q.question,
        header: q.question.slice(0, 30),
        options: q.options.map((label) => ({ label, description: label })),
      })),
    }),
  questionReplied: (requestID: string) =>
    event("question.replied", { sessionID, requestID, answers: [] }),
});

/** A recorded fixture: one `/event` payload per line. */
export const readFixture = (name: string): ReadonlyArray<Payload> =>
  readFileSync(join(import.meta.dir, "..", "fixtures", name), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line): Payload => JSON.parse(line));
