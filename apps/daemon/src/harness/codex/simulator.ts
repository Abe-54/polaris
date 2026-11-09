/**
 * The Simulator's MCP server in a Codex thread: a `mcp_servers` entry in `thread/start`'s
 * config, a URL that carries the session's token.
 */
import { Effect } from "effect";
import type { OpenOptions } from "../HarnessDriver.ts";
import type { ToolServers } from "../toolServers.ts";
import { codexBrowserConfig } from "./browser.ts";
import {
  SIMULATOR_MCP_NAME,
  SIMULATOR_TOOL_TIMEOUT_SECONDS,
  type SimulatorMcp,
} from "../simulator/index.ts";

/** No `approval_mode` override: each tool call asks as the thread's approval policy says. */
export const codexSimulatorConfig = Effect.fnUntraced(function* (
  simulator: SimulatorMcp["Service"] | undefined,
  options: OpenOptions
) {
  if (simulator === undefined || options.readOnly === true) return {};
  const server = yield* simulator.forSession(options.sessionId);

  if (server === null) return {};

  return {
    [`mcp_servers.${SIMULATOR_MCP_NAME}`]: {
      url: server.url,
      tool_timeout_sec: SIMULATOR_TOOL_TIMEOUT_SECONDS,
    },
  };
});

/** The Browser's and the Simulator's `mcp_servers` entries. */
export const codexToolServers = Effect.fnUntraced(function* (
  servers: ToolServers,
  options: OpenOptions
) {
  const browser = yield* codexBrowserConfig(servers.browser, options);
  const simulator = yield* codexSimulatorConfig(servers.simulator, options);

  return { ...browser, ...simulator };
});
