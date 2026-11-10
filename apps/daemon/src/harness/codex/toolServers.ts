/**
 * The MCP servers Polaris adds to a Codex thread's config beside a Constellation's: the Browser's
 * (`polaris_browser`), the Simulator's and computer use (`polaris_desktop`), with Codex's own off.
 */
import { Effect } from "effect";
import type { OpenOptions } from "../HarnessDriver.ts";
import type { ToolServers } from "../toolServers.ts";
import { codexBrowserConfig } from "./browser.ts";
import { codexDesktopConfig } from "./desktop.ts";
import { codexSimulatorConfig } from "./simulator.ts";

export const codexToolServers = Effect.fnUntraced(function* (
  servers: ToolServers,
  options: OpenOptions
) {
  const browser = yield* codexBrowserConfig(servers.browser, options);
  const simulator = yield* codexSimulatorConfig(servers.simulator, options);
  const desktop = yield* codexDesktopConfig(servers.desktop, options);

  return { ...browser, ...simulator, ...desktop };
});
