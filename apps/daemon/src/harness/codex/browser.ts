/**
 * The Browser's MCP server in a Codex thread: a `mcp_servers` entry in `thread/start`'s config.
 * Its env names the session's config file, which holds the relay URL.
 */
import { Effect } from "effect";
import { BROWSER_MCP_NAME, type BrowserMcp } from "../browser/index.ts";
import type { OpenOptions } from "../HarnessDriver.ts";

/** No `approval_mode` override: each tool call asks as the thread's approval policy says. */
export const codexBrowserConfig = Effect.fnUntraced(function* (
  browser: BrowserMcp["Service"] | undefined,
  options: OpenOptions
) {
  if (browser === undefined || options.readOnly === true) return {};
  const server = yield* browser.forSession(options.sessionId);

  if (server === null) return {};

  return {
    [`mcp_servers.${BROWSER_MCP_NAME}`]: {
      command: server.command,
      args: [...server.args],
      env: { ...server.env },
    },
  };
});
