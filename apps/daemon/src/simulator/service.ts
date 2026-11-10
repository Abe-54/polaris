/**
 * The `SimulatorHub` service: the Host's Simulators behind the `simulator.*` RPCs and the
 * Simulator MCP server. Only types here, so the Daemon starts without loading the hub (`hub.ts`).
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
import { Context, type Effect, type Scope, type Stream } from "effect";

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
