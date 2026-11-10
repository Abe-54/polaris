/**
 * The MCP servers Polaris adds to a Claude Code session beside a Constellation's: the Browser's
 * (`polaris_browser`), the Simulator's (`polaris_simulator`) and computer use (`polaris_desktop`).
 */
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";
import type { OpenOptions } from "../HarnessDriver.ts";
import type { ToolServers } from "../toolServers.ts";
import { claudeBrowserOptions } from "./browser.ts";
import { claudeSimulatorOptions } from "./simulator.ts";

/** Loads the desktop server's module (zod, the SDK's MCP server) only when a session needs it. */
const desktopOptions = Effect.fnUntraced(function* (
  desktop: ToolServers["desktop"],
  options: OpenOptions,
  sdkOptions: Options
) {
  if (desktop === undefined || options.readOnly === true) return {};
  const { claudeDesktopOptions } = yield* Effect.promise(() => import("./desktop.ts"));

  return yield* claudeDesktopOptions(desktop, options, sdkOptions);
});

/** Each server sees the ones before it in `mcpServers`, so none drops another's entry. */
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

  const desktop = yield* desktopOptions(servers.desktop, options, {
    ...sdkOptions,
    ...browser,
    ...simulator,
  });

  return { ...browser, ...simulator, ...desktop } satisfies Partial<Options>;
});
