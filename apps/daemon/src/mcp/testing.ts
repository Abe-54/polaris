import {
  AttemptId,
  ConstellationId,
  ConstellationResult,
  SessionId,
  type ConstellationCommand,
} from "@polaris/protocol";
import { Effect } from "effect";
import { McpBinding, type SessionBinding } from "./binding.ts";
import type { ConstellationCommands } from "./tools.ts";

export const workerBinding = McpBinding.cases.Worker.make({
  sessionId: SessionId.make("worker-1"),
  constellationId: ConstellationId.make("c1"),
  attemptId: AttemptId.make("attempt-1"),
});

export const leadBinding = McpBinding.cases.Lead.make({
  sessionId: SessionId.make("lead-1"),
  constellationId: ConstellationId.make("c1"),
});

/** The tools each role sees, in order: every transport must list exactly these. */
export const WORKER_TOOL_NAMES = [
  "block",
  "progress",
  "ask",
  "claim",
  "propose",
  "message",
  "status",
  "wait_for_command",
  "notify",
  "request_secret",
  "sessions",
  "search_history",
  "read_history",
  "data_sources",
  "describe",
  "query",
  "execute",
  "visualize",
];

export const LEAD_TOOL_NAMES = [
  "plan",
  "dispatch",
  "review",
  "answer",
  "message",
  "status",
  "set_state",
  "read_worker",
  "wait_for_command",
  "notify",
  "request_secret",
  "sessions",
  "search_history",
  "read_history",
  "data_sources",
  "describe",
  "query",
  "execute",
  "visualize",
];

export const fakeCommands = () => {
  const calls: Array<{ binding: SessionBinding; command: ConstellationCommand; id: string }> = [];
  const references: Array<string> = [];

  const result = new ConstellationResult({
    summary: "Recorded.",
    next: "Review the Claim.",
    revision: 7,
    sequence: null,
  });

  const commands: ConstellationCommands = {
    command: (binding, id, command) =>
      Effect.sync(() => {
        calls.push({ binding, command, id });

        return result;
      }),
    status: () => Effect.succeed(result),
    resolve: (_binding, _id, kind, name) =>
      Effect.sync(() => {
        references.push(`${kind}:${name}`);

        return `${kind}-${name}`;
      }),
  };

  return { commands, calls, references };
};
