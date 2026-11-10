/**
 * `polaris_desktop`'s service key and the types the Engine and the Harness registry share: all
 * the Daemon loads at startup. The server itself (`index.ts`) loads on first use.
 */
import type { ComputerUseState, SessionId } from "@polaris/protocol";
import { Context, Data, Effect, Layer, type Scope } from "effect";
import type { Json } from "./catalog.ts";
import type { DesktopResult } from "./envelope.ts";
import type { ListedTool } from "./http.ts";

export type ComputerUseOutcome = Data.TaggedEnum<{
  /** The Host turned Ready: the Daemon withdrew the request. */
  Ready: Record<never, never>;
  /** The user picked Not now (`Deny`). */
  NotNow: Record<never, never>;
  TimedOut: Record<never, never>;
  /** The request went away unanswered: the Turn ended or was stopped. */
  Ended: { readonly reason: string };
  NoTurn: Record<never, never>;
  NotFound: Record<never, never>;
}>;

export const ComputerUseOutcome = Data.taggedEnum<ComputerUseOutcome>();

export interface ComputerUseAsk {
  readonly state: ComputerUseState;
  readonly app: string;
  readonly reason: string;
  readonly timeoutMs: number;
  /** Completes once the Host is Ready. */
  readonly ready: Effect.Effect<void>;
}

/** The Engine's side: opens the approval on the Turn in flight and waits (`ComputerUseRequests`). */
export type RequestComputerUse = (
  sessionId: SessionId,
  ask: ComputerUseAsk
) => Effect.Effect<ComputerUseOutcome>;

export interface DesktopBoundTool extends ListedTool {
  readonly call: (input: Json, signal?: AbortSignal) => Promise<DesktopResult>;
}

export interface DesktopServer {
  readonly tools: ReadonlyArray<DesktopBoundTool>;
  readonly instructions: string;
  /** The longest one call may take, for Harnesses that time tool calls out. */
  readonly callSeconds: number;
  /** Codex's way in: a loopback URL that lasts as long as the scope. */
  readonly url: Effect.Effect<string, never, Scope.Scope>;
}

export interface DesktopSessionOpen {
  readonly sessionId: SessionId;
  /** Read-only sessions and the Reviewer never get computer use. */
  readonly readOnly?: boolean;
}

export class DesktopMcp extends Context.Service<
  DesktopMcp,
  {
    /**
     * The session's server while the scope lasts: every tool when the Host is Ready, only
     * `request_computer_use` when it's Off or NeedsSetup. Null for read-only sessions, a Host
     * with no desktop, and on any failure, so the session opens without computer use.
     */
    readonly forSession: (
      options: DesktopSessionOpen
    ) => Effect.Effect<DesktopServer | null, never, Scope.Scope>;
    /** The Engine's `ComputerUseRequests.request`, bound once the Engine is built. */
    readonly bindRequests: (request: RequestComputerUse) => Effect.Effect<void>;
  }
>()("polaris/daemon/harness/DesktopMcp") {
  static readonly none = Layer.succeed(DesktopMcp)(
    DesktopMcp.of({ forSession: () => Effect.succeed(null), bindRequests: () => Effect.void })
  );
}
