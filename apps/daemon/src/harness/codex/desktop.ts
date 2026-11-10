/**
 * `polaris_desktop` in a Codex thread: a loopback Streamable HTTP server in `thread/start`'s
 * config. Codex's own computer use is always off, so its tools never compete with these.
 */
import { Effect } from "effect";
import type { OpenOptions } from "../HarnessDriver.ts";
import { DESKTOP_MCP_NAME, type DesktopMcp } from "../desktop/index.ts";

/** Set on every thread, with or without polaris_desktop. */
export const CODEX_COMPUTER_USE_OFF = { "features.computer_use": false } as const;

/** Pre-approved: Polaris's own approvals (`authorize`, D3) gate each app instead. */
export const codexDesktopConfig = Effect.fnUntraced(function* (
  desktop: DesktopMcp["Service"] | undefined,
  options: OpenOptions
) {
  if (desktop === undefined || options.readOnly === true) return CODEX_COMPUTER_USE_OFF;
  const server = yield* desktop.forSession(options);

  if (server === null) return CODEX_COMPUTER_USE_OFF;

  return {
    ...CODEX_COMPUTER_USE_OFF,
    [`mcp_servers.${DESKTOP_MCP_NAME}`]: {
      url: yield* server.url,
      tool_timeout_sec: server.callSeconds,
      tools: Object.fromEntries(
        server.tools.map((t) => [t.name, { approval_mode: "approve" }] as const)
      ),
    },
  };
});
