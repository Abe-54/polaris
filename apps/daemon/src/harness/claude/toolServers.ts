/**
 * The MCP servers Polaris adds to a Claude Code session beside a Constellation's: the Browser's
 * (`polaris_browser`) and computer use (`polaris_desktop`). Read-only sessions get neither.
 */
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";
import type { BrowserMcp } from "../browser/index.ts";
import type { DesktopMcp } from "../desktop/index.ts";
import type { OpenOptions } from "../HarnessDriver.ts";
import { claudeBrowserOptions } from "./browser.ts";

export interface ToolServerOptions {
  /** The Browser's MCP server for each session that isn't read-only. */
  readonly browser?: BrowserMcp["Service"];
  /** Computer use for each session that isn't read-only, once the Host is ready. */
  readonly desktop?: DesktopMcp["Service"] | undefined;
}

/** Loads the desktop server's module (zod, the SDK's MCP server) only when a session needs it. */
export const claudeToolServers = Effect.fnUntraced(function* (
  servers: ToolServerOptions,
  options: OpenOptions,
  sdkOptions: Options
) {
  const browser = yield* claudeBrowserOptions(servers.browser, options, sdkOptions);

  if (servers.desktop === undefined || options.readOnly === true) return browser;
  const { claudeDesktopOptions } = yield* Effect.promise(() => import("./desktop.ts"));

  const desktop = yield* claudeDesktopOptions(servers.desktop, options, {
    ...sdkOptions,
    ...browser,
  });

  return { ...browser, ...desktop } satisfies Partial<Options>;
});
