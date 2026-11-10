/**
 * What the Simulator tools tell the rest of the Daemon about an Agent Session's Simulator: the
 * subset of D2's `SimulatorHub` they call. `sessionFeed` carries what these publish.
 */
import type { SessionId } from "@polaris/protocol";
import { Effect, type Scope } from "effect";

export interface SimulatorActivity {
  /** Marks `id` as the session's shown Simulator and publishes `AgentOpened`. */
  readonly agentOpened: (sessionId: SessionId, id: string) => Effect.Effect<void>;
  /** `AgentDriving { active: true }` while any holder's scope is open. */
  readonly agentDriving: (sessionId: SessionId) => Effect.Effect<void, never, Scope.Scope>;
  /** The Simulator the session shows, or null. */
  readonly shown: (sessionId: SessionId) => Effect.Effect<string | null>;
  /** An agent's open booted `id` from Shutdown: recorded as booted by Polaris. */
  readonly agentBooted: (id: string) => Effect.Effect<void>;
}

/** Records nothing: for tests that don't look at the session's feed. */
export const noActivity: SimulatorActivity = {
  agentOpened: () => Effect.void,
  agentDriving: () => Effect.void,
  shown: () => Effect.succeed(null),
  agentBooted: () => Effect.void,
};
