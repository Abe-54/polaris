/**
 * The Simulator's MCP server in a Claude Code session: an HTTP entry whose URL carries the
 * session's token. Its tools stay out of `allowedTools`: each call asks as the mode says.
 */
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";
import type { OpenOptions } from "../HarnessDriver.ts";
import type { ToolServers } from "../toolServers.ts";
import { claudeBrowserOptions } from "./browser.ts";
import { SIMULATOR_MCP_NAME, type SimulatorMcp } from "../simulator/index.ts";

export const claudeSimulatorOptions = Effect.fnUntraced(function* (
  simulator: SimulatorMcp["Service"] | undefined,
  options: OpenOptions,
  sdkOptions: Options
) {
  if (simulator === undefined || options.readOnly === true) return {};
  const server = yield* simulator.forSession(options.sessionId);

  if (server === null) return {};

  return {
    mcpServers: {
      ...sdkOptions.mcpServers,
      [SIMULATOR_MCP_NAME]: { type: "http", url: server.url },
    },
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
