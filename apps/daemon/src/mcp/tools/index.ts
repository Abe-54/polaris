import { CommandId } from "@polaris/protocol";
import { Effect, Schema } from "effect";
import { McpBinding, sessionBinding } from "../binding.ts";
import { leadTools } from "./lead.ts";
import { workerTools } from "./worker.ts";
import { resolvers } from "./resolve.ts";
import { CallCommandId, idempotency, type Idempotency } from "./idempotency.ts";
import { notifyTool, readWorkerTool, waitForCommandTool } from "./session.ts";
import { historyTools } from "./history.ts";
import { memoryVisualizations, visualizeTool } from "./visualize.ts";
import type { VisualizationLog } from "../tokens.ts";
import { unavailableSessions, type SessionTools } from "../sessions/index.ts";
import { dataTools } from "./data.ts";
import { profileTool } from "./profile.ts";
import { traceTools } from "./traces.ts";
import { requestSecretTool } from "./secret.ts";
import {
  toolFactory,
  rejection,
  errorResult,
  type BoundTool,
  type ConstellationCommands,
  type LeadStarted,
  type StartTarget,
} from "./shared.ts";

export { errorResult } from "./shared.ts";

export type { BoundTool, ConstellationCommands, LeadStarted, McpToolResult } from "./shared.ts";

export type { VisualizationLog } from "../tokens.ts";

export { unavailableCommands } from "./unavailable.ts";

/** Each Daemon's commands keep their own recent implicit ids. */
const idsByCommands = new WeakMap<ConstellationCommands, Idempotency>();

const idsFor = (commands: ConstellationCommands) => {
  const known = idsByCommands.get(commands);

  if (known !== undefined) return known;
  const ids = idempotency();
  idsByCommands.set(commands, ids);

  return ids;
};

const sessionsByCommands = new WeakMap<ConstellationCommands, SessionTools>();

/** The session tools that serve catalogs over these commands; `mcpHttp` registers the Daemon's. */
export const attachSessionTools = (commands: ConstellationCommands, sessions: SessionTools) => {
  sessionsByCommands.set(commands, sessions);
};

const visualizationsByCommands = new WeakMap<ConstellationCommands, VisualizationLog>();

/** Where `visualize` records the ids it returns; `mcpHttp` attaches the Daemon's durable log. */
export const attachVisualizations = (commands: ConstellationCommands, log: VisualizationLog) => {
  visualizationsByCommands.set(commands, log);
};

const visualizationsFor = (commands: ConstellationCommands) => {
  const known = visualizationsByCommands.get(commands);

  if (known !== undefined) return known;
  const log = memoryVisualizations();
  visualizationsByCommands.set(commands, log);

  return log;
};

export interface CatalogOptions {
  /** False when the Visuals setting was `off` as the session opened: no `visualize`. */
  readonly visualize?: boolean;
}

/** A closed Lead binding starts its `next` Constellation; any other starts its own id. */
const startTarget = (binding: McpBinding, started?: LeadStarted): StartTarget => {
  const next = McpBinding.isAnyOf(["Lead"])(binding) ? binding.next : undefined;

  if (next === undefined) return { constellationId: binding.constellationId, started: Effect.void };

  return {
    constellationId: next,
    started: started === undefined ? Effect.void : started(binding.sessionId, next),
  };
};

/** E reauthorizes the authenticated session under the store lock on every command. */
export const constellationTools = (
  binding: McpBinding,
  commands: ConstellationCommands,
  started?: LeadStarted,
  options: CatalogOptions = {}
): ReadonlyArray<BoundTool> => {
  const caller = sessionBinding(binding);

  const define = toolFactory(() => commands.status(caller, binding.constellationId, true), {
    sessionId: binding.sessionId,
    ids: idsFor(commands),
  });

  const submit = (command: Parameters<ConstellationCommands["command"]>[2]) =>
    Effect.gen(function* () {
      const id = yield* CallCommandId;

      return yield* commands.command(caller, id ?? CommandId.make(crypto.randomUUID()), command);
    });

  const status = define(
    "status",
    "Read the graph as a tree by group and parent, with Claims, questions and ready Tasks. Do not poll; updates arrive as Lead Turns.",
    Schema.Struct({ json: Schema.optionalKey(Schema.Boolean) }),
    (input) => commands.status(caller, binding.constellationId, input.json ?? false),
    { json: (input) => input.json ?? false }
  );

  const sessions = sessionsByCommands.get(commands) ?? unavailableSessions;
  const wait = waitForCommandTool(binding.sessionId, sessions);

  const lead = (): ReadonlyArray<BoundTool> => {
    const resolve = resolvers(binding, commands);

    return [
      ...leadTools(binding, define, submit, resolve, status, startTarget(binding, started)),
      readWorkerTool(binding, commands, resolve, sessions),
    ];
  };

  const catalog = McpBinding.match(binding, {
    Plain: () =>
      lead().map((tool): BoundTool => ({
        ...tool,
        call: (input) =>
          tool.call(input).then((result) => {
            if (
              result.structuredContent?.graph !== null ||
              result.structuredContent.revision !== 0 ||
              !result.structuredContent.findings?.some((finding) => finding.code === "E-NOT-FOUND")
            )
              return result;

            return errorResult(
              rejection(
                "E-START-FIRST",
                "Start a Constellation first",
                "Call plan with start { name, workspaceId } and operations []."
              )
            );
          }),
      })),
    Lead: lead,
    Worker: (bound) => workerTools(bound, define, submit, status),
  });

  return [
    ...catalog,
    wait,
    notifyTool(binding.sessionId, sessions, idsFor(commands)),
    requestSecretTool(binding.sessionId, sessions),
    ...historyTools(binding.sessionId, sessions),
    ...dataTools(binding.sessionId, sessions),
    ...traceTools(binding.sessionId, sessions),
    profileTool(binding.sessionId, sessions),
    ...(options.visualize === false
      ? []
      : [visualizeTool(binding.sessionId, visualizationsFor(commands))]),
  ];
};
