/**
 * The `SimulatorMcp` service, `polaris_simulator` for an Agent Session. Only types and names
 * here, so the Harness drivers load without the server (`index.ts`).
 */
import type { SessionId } from "@polaris/protocol";
import { Context, Effect, Layer, type Schema, type Scope } from "effect";
import type { ToolResult } from "./session.ts";
import type { SimulatorTool } from "./tools.ts";

/** Not `simulator`: a user's own server of that name would shadow or be shadowed by it. */
export const SIMULATOR_MCP_NAME = "polaris_simulator";

/** Codex's per-call limit: past the 45 s a call waits before saying it carries on. */
export const SIMULATOR_TOOL_TIMEOUT_SECONDS = 120;

/**
 * The session's tools two ways: `url` (its token in the path) for a Harness that takes the
 * config off argv, and `call` in-process for one whose config `ps` would show.
 */
export interface SimulatorMcpServer {
  readonly url: string;
  readonly tools: ReadonlyArray<SimulatorTool>;
  readonly call: (name: string, input: typeof Schema.Json.Type) => Promise<ToolResult>;
}

export class SimulatorMcp extends Context.Service<
  SimulatorMcp,
  {
    /**
     * The session's server while the scope lasts, or null on a Host that can't run Simulators
     * or when setup fails: never a failure, so the session opens without Simulator tools.
     */
    readonly forSession: (
      sessionId: SessionId
    ) => Effect.Effect<SimulatorMcpServer | null, never, Scope.Scope>;
  }
>()("polaris/daemon/harness/SimulatorMcp") {
  static readonly none = Layer.succeed(SimulatorMcp)(
    SimulatorMcp.of({ forSession: () => Effect.succeed(null) })
  );
}
