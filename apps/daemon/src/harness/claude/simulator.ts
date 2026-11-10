/**
 * The Simulator's MCP server in a Claude Code session, in-process: the SDK puts `mcpServers` on
 * `claude`'s argv, where `ps` would show a token URL. Its tools stay out of `allowedTools`.
 */
import { createSdkMcpServer, type Options, tool } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Schema } from "effect";
import { z } from "zod";
import type { OpenOptions } from "../HarnessDriver.ts";
import type { ToolServers } from "../toolServers.ts";
import { claudeBrowserOptions } from "./browser.ts";
import {
  SIMULATOR_MCP_NAME,
  type SimulatorMcp,
  type SimulatorMcpServer,
} from "../../simulator/service.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.Json);

const sdkServer = (server: SimulatorMcpServer) =>
  createSdkMcpServer({
    name: SIMULATOR_MCP_NAME,
    version: "1",
    tools: server.tools.map((simulatorTool) => {
      const schema = z.fromJSONSchema(simulatorTool.inputSchema);

      if (!(schema instanceof z.ZodObject))
        throw new Error("Simulator tool input must be an object");

      return tool(
        simulatorTool.name,
        simulatorTool.description,
        schema.shape,
        async (input) => ({ ...(await server.call(simulatorTool.name, decodeJson(input))) }),
        { annotations: { readOnlyHint: simulatorTool.readOnly } }
      );
    }),
  });

export const claudeSimulatorOptions = Effect.fnUntraced(function* (
  simulator: SimulatorMcp["Service"] | undefined,
  options: OpenOptions,
  sdkOptions: Options
) {
  if (simulator === undefined || options.readOnly === true) return {};
  const server = yield* simulator.forSession(options.sessionId);

  if (server === null) return {};

  return {
    mcpServers: { ...sdkOptions.mcpServers, [SIMULATOR_MCP_NAME]: sdkServer(server) },
  } satisfies Partial<Options>;
});

/** The Browser's and the Simulator's servers, side by side. */
export const claudeToolServers = Effect.fnUntraced(function* (
  servers: ToolServers,
  options: OpenOptions,
  sdkOptions: Options
) {
  const browser = yield* claudeBrowserOptions(servers.browser, options, sdkOptions);

  const simulator = yield* claudeSimulatorOptions(servers.simulator, options, {
    ...sdkOptions,
    ...browser,
  });

  return { ...browser, ...simulator };
});
