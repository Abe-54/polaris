/**
 * The Browser's MCP server in a Claude Code session. The SDK puts `mcpServers` on `claude`'s
 * argv; the entry carries only the path of the session's config, which holds the relay URL.
 */
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";
import { BROWSER_MCP_NAME, type BrowserMcp } from "../browser/index.ts";
import type { OpenOptions } from "../HarnessDriver.ts";

/** Its tools stay out of `allowedTools`: each call asks as the permission mode says. */
export const claudeBrowserOptions = Effect.fnUntraced(function* (
  browser: BrowserMcp["Service"] | undefined,
  options: OpenOptions,
  sdkOptions: Options
) {
  if (browser === undefined || options.readOnly === true) return {};
  const server = yield* browser.forSession(options.sessionId);

  if (server === null) return {};

  return {
    mcpServers: {
      ...sdkOptions.mcpServers,
      [BROWSER_MCP_NAME]: {
        type: "stdio",
        command: server.command,
        args: [...server.args],
        env: { ...server.env },
      },
    },
  } satisfies Partial<Options>;
});
