import type {
  Attempt,
  ConstellationCommand,
  HostId,
  SessionId,
  ToolCallReference,
  TurnItem,
} from "@polaris/protocol";

/** Supplied by the authenticated connection or session MCP binding, never by command arguments. */
export type ConstellationBinding =
  | { readonly kind: "user" }
  | { readonly kind: "session"; readonly sessionId: SessionId };

export interface ClaimProbe {
  readonly dirtyPaths: ReadonlyArray<string>;
  readonly branch: string;
  readonly head: string;
}

export interface RecordedCheck {
  readonly reference: ToolCallReference;
  readonly item: TurnItem;
}

/** All external observations needed by the pure graph decider. */
export interface ConstellationContext {
  readonly binding: ConstellationBinding;
  readonly hostId: HostId;
  readonly now: string;
  readonly attempts: ReadonlyArray<Attempt>;
  readonly handoverDeferred?: boolean;
  readonly newLeadSessionId: SessionId | null;
  /** The Lead checkout's branch, read when a Plan starts the graph. */
  readonly leadBranch?: string | undefined;
  readonly claimProbe: ClaimProbe | null;
  readonly recordedChecks: ReadonlyArray<RecordedCheck>;
  /** What Accept's merge found, recorded on the accepted Attempt (ENG-276). */
  readonly mergeFindings?: ReadonlyArray<import("@polaris/protocol").ConstellationFinding>;
  readonly offlineSessionIds: ReadonlySet<SessionId>;
  readonly commanded: boolean;
  readonly defaults: import("@polaris/protocol").ConstellationSettings;
  readonly resourceHolders: ReadonlyArray<{
    readonly hostId: HostId;
    readonly name: string;
    readonly holders: number;
  }>;
  /** Active worker sessions across all other Constellations on this Host. */
  readonly occupiedSessions: ReadonlySet<SessionId>;
}

export type GraphCommand<Tag extends ConstellationCommand["_tag"]> = Extract<
  ConstellationCommand,
  { _tag: Tag }
>;
