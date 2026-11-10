/**
 * The MCP servers Polaris adds to a Codex thread's config beside a Constellation's: the
 * Browser's (`polaris_browser`) and computer use (`polaris_desktop`), with Codex's own off.
 */
import { Effect } from "effect";
import type { BrowserMcp } from "../browser/index.ts";
import type { DesktopMcp } from "../desktop/index.ts";
import type { OpenOptions } from "../HarnessDriver.ts";
import { codexBrowserConfig } from "./browser.ts";
import { codexDesktopConfig } from "./desktop.ts";

export interface ToolServerConfig {
  /** The Browser's MCP server for each thread that isn't read-only. */
  readonly browser?: BrowserMcp["Service"] | undefined;
  /** Computer use for each thread that isn't read-only, once the Host is ready. */
  readonly desktop?: DesktopMcp["Service"] | undefined;
}

export const codexToolServers = Effect.fnUntraced(function* (
  servers: ToolServerConfig,
  options: OpenOptions
) {
  const browser = yield* codexBrowserConfig(servers.browser, options);
  const desktop = yield* codexDesktopConfig(servers.desktop, options);

  return { ...browser, ...desktop };
});
