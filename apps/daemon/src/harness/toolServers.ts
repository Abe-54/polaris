/** The Daemon's own MCP servers that Claude Code and Codex sessions get unless read-only. */
import type { BrowserMcp } from "./browser/index.ts";
import type { DesktopMcp } from "./desktop/index.ts";
import type { SimulatorMcp } from "../simulator/service.ts";

export interface ToolServers {
  /** The Browser's MCP server (ADR 0092). */
  readonly browser?: BrowserMcp["Service"] | undefined;
  /** The Simulator's MCP server, `polaris_simulator`. */
  readonly simulator?: SimulatorMcp["Service"] | undefined;
  /** Computer use, `polaris_desktop`, once the Host is ready (ADR 0107). */
  readonly desktop?: DesktopMcp["Service"] | undefined;
}
