/**
 * What the Daemon loads of the Simulator at start: the `SimulatorHub` and `SimulatorMcp` service
 * tags and the pure capability check. The hub (`hub.ts`) and the MCP server load on first use.
 */
import type {
  HubFailed,
  NotFound,
  SessionId,
  SimulatorAttachItem,
  SimulatorNotBootedByPolaris,
  SimulatorNotFound,
  SimulatorSessionItem,
  SimulatorUnavailable,
  SimulatorWatchItem,
  Unsupported,
} from "@polaris/protocol";
import { Context, Effect, Layer, type Schema, type Scope, type Stream } from "effect";
import type { SimulatorTool } from "../harness/simulator/tools.ts";
import type { ToolResult } from "../harness/simulator/session.ts";
import type { PlatformFacts } from "../platform/index.ts";

/** iOS Simulators run only on a Mac. */
export const iosPossible = (facts: PlatformFacts): boolean => facts.os === "darwin";

/**
 * Google ships the emulator for macOS and glibc Linux on x64; Linux on arm64 (the Pi) has none.
 * Windows waits until the hub is proven there.
 */
export const androidPossible = (facts: PlatformFacts): boolean =>
  facts.os === "darwin" || (facts.os === "linux" && facts.arch === "x64" && facts.libc === "glibc");

/** Whether `simulator` is advertised: some platform isn't `Unsupported`. A pure check, no I/O. */
export const simulatorCapable = (facts: PlatformFacts): boolean =>
  iosPossible(facts) || androidPossible(facts);

type SimulatorError = SimulatorNotFound | SimulatorUnavailable | HubFailed | Unsupported;

export class SimulatorHub extends Context.Service<
  SimulatorHub,
  {
    readonly watch: Stream.Stream<SimulatorWatchItem, Unsupported>;
    readonly boot: (id: string) => Effect.Effect<void, SimulatorError>;
    readonly shutdown: (
      id: string,
      force: boolean
    ) => Effect.Effect<void, SimulatorError | SimulatorNotBootedByPolaris>;
    readonly restart: Effect.Effect<void, SimulatorUnavailable | HubFailed | Unsupported>;
    readonly attach: (
      sessionId: SessionId,
      id: string
    ) => Stream.Stream<SimulatorAttachItem, SimulatorError | NotFound>;
    readonly sessionFeed: (
      sessionId: SessionId
    ) => Stream.Stream<SimulatorSessionItem, NotFound | Unsupported>;
    /** An agent opened `id`: the session shows it. Doesn't start the hub; restarts its idle clock. */
    readonly agentOpened: (sessionId: SessionId, id: string) => Effect.Effect<void>;
    /** An agent drives the shown Simulator for the scope: `AgentDriving` on 0→1 and 1→0. */
    readonly agentDriving: (sessionId: SessionId) => Effect.Effect<void, never, Scope.Scope>;
    /** The Simulator the session shows, or null. */
    readonly shown: (sessionId: SessionId) => Effect.Effect<string | null>;
    /** An agent booted `id` itself (agent-device `open`): Polaris shuts it down on idle. */
    readonly agentBooted: (id: string) => Effect.Effect<void>;
  }
>()("polaris/daemon/simulator/SimulatorHub") {}

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
