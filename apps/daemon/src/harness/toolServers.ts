/** The Daemon's own MCP servers that Claude Code and Codex sessions get unless read-only. */
import type { BrowserMcp } from "./browser/index.ts";
import type { SimulatorMcp } from "./simulator/service.ts";

export interface ToolServers {
  /** The Browser's MCP server (ADR 0092). */
  readonly browser?: BrowserMcp["Service"] | undefined;
  /** The Simulator's MCP server, `polaris_simulator`. */
  readonly simulator?: SimulatorMcp["Service"] | undefined;
}
