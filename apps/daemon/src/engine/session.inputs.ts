/**
 * The session machine's vocabulary (README.md here): its inputs, Client
 * commands and engine signals, as Effect Schemas, and what it emits.
 */
import {
  AgentSession,
  BackgroundTask,
  ApprovalDecision,
  ApprovalRequest,
  type DomainEvent,
  ModelId,
  PermissionMode,
  ReasoningEffort,
  ServiceTier,
  RequestId,
  Subagent,
  SubagentId,
  Turn,
  TurnId,
  TurnTrigger,
  TurnStatus,
  WorktreeSetupRun,
} from "@polaris/protocol";
import { Schema } from "effect";
import type { EventObject } from "xstate";

// Effect Schemas as Standard Schemas: XState v6 infers its event types from them.
const standard = Schema.toStandardSchemaV1;

const At = { at: Schema.String };

const Nothing = standard(Schema.Struct({}));

export const eventSchemas = {
  // Client commands
  "session.start": standard(Schema.Struct({ session: AgentSession, turn: Turn })),
  "session.fork": standard(Schema.Struct({ session: AgentSession })),
  "turn.send": standard(Schema.Struct({ turn: Turn })),
  "turn.continue": Nothing,
  "turn.retry": standard(Schema.Struct({ turn: Turn })),
  "turn.steer": standard(
    Schema.Struct({
      canSteer: Schema.Boolean,
      /** False when the steer carries attachments its Harness can't take mid-Turn. */
      takesAttachments: Schema.Boolean,
    })
  ),
  "turn.interrupt": Nothing,
  "background.stop": standard(
    Schema.Struct({
      taskIds: Schema.NullOr(Schema.Array(Schema.String)),
      canStop: Schema.Boolean,
    })
  ),
  "command.background": standard(
    Schema.Struct({
      itemId: Schema.NullOr(Schema.String),
      canBackground: Schema.Boolean,
      running: Schema.Array(Schema.String),
    })
  ),
  "approval.respond": standard(
    Schema.Struct({ requestId: RequestId, decision: ApprovalDecision, resolvedBy: Schema.String })
  ),
  "permissionMode.set": standard(Schema.Struct({ permissionMode: PermissionMode })),
  "model.set": standard(
    Schema.Struct({
      model: Schema.NullOr(ModelId),
      effort: Schema.NullOr(ReasoningEffort),
      serviceTier: Schema.NullOr(ServiceTier),
      canSwitchModel: Schema.Boolean,
    })
  ),
  "turns.accept": standard(
    Schema.Struct({
      turnId: TurnId,
      index: Schema.Int,
      status: TurnStatus,
      revertLaterTurns: Schema.Boolean,
      acceptedBy: Schema.String,
    })
  ),
  "session.archive": standard(Schema.Struct(At)),
  "session.unarchive": Nothing,
  "terminal.open": Nothing,
  "terminal.return": Nothing,
  // Engine signals
  "turn.deliver": standard(
    Schema.Struct({ turn: Turn, targetTurnId: TurnId, refusal: Schema.NullOr(Schema.String) })
  ),
  "harness.opened": Nothing,
  "harness.turnStarted": standard(
    Schema.Struct({
      turnId: TurnId,
      prompt: Schema.String,
      trigger: Schema.NullOr(TurnTrigger),
      ...At,
    })
  ),
  "harness.approvalRequested": standard(Schema.Struct({ request: ApprovalRequest })),
  "harness.approvalWithdrawn": standard(
    Schema.Struct({
      requestId: RequestId,
      /** Default `harness`; `daemon` for a Secret Request that timed out (ADR 0089). */
      withdrawnBy: Schema.optionalKey(Schema.Literals(["harness", "daemon"])),
      reason: Schema.optionalKey(Schema.String),
    })
  ),
  "harness.backgroundTasksChanged": standard(
    Schema.Struct({ tasks: Schema.Array(BackgroundTask) })
  ),
  "harness.subagentStarted": standard(Schema.Struct({ subagent: Subagent })),
  "harness.subagentEnded": standard(
    Schema.Struct({
      subagentId: SubagentId,
      report: Schema.NullOr(Schema.String),
      status: Schema.Literals(["completed", "failed", "interrupted"]),
      ...At,
    })
  ),
  "harness.turnEnded": standard(
    Schema.Struct({
      turnId: TurnId,
      status: Schema.Literals(["completed", "interrupted", "failed"]),
      error: Schema.NullOr(Schema.String),
      checkpoint: Schema.NullOr(Schema.Struct({ ref: Schema.String, commit: Schema.String })),
      /** A failed Turn the Harness ended at a usage limit (the supervisor classifies it). */
      limit: Schema.optionalKey(
        Schema.NullOr(Schema.Struct({ resetsAt: Schema.NullOr(Schema.String) }))
      ),
      ...At,
    })
  ),
  "harness.exited": standard(Schema.Struct({ error: Schema.NullOr(Schema.String), ...At })),
  "harness.resumed": Nothing,
  "terminal.closed": standard(Schema.Struct(At)),
  "idle.timeout": standard(
    Schema.Struct({
      harnessLive: Schema.Boolean,
      backgroundExpired: Schema.optionalKey(Schema.Boolean),
      at: Schema.optionalKey(Schema.String),
    })
  ),
  "session.setup": standard(Schema.Struct({ setup: WorktreeSetupRun })),
  "session.fail": standard(Schema.Struct({ message: Schema.String, ...At })),
  "turn.interruptUnattended": standard(Schema.Struct(At)),
  "daemon.recover": standard(
    Schema.Struct({
      cause: Schema.Literals(["restart", "upgrade"]),
      /** What stopped the Daemon, for copy and reasons only; `cause` decides. Defaults to `cause`. */
      stoppedFor: Schema.optionalKey(Schema.Literals(["restart", "upgrade"])),
      ...At,
    })
  ),
};

type EventSchemas = typeof eventSchemas;

/** An input to the session machine: a Client command or an engine signal. */
export type SessionInput = {
  [K in keyof EventSchemas]: { readonly type: K } & EventSchemas[K]["Type"];
}[keyof EventSchemas];

/** Something the engine does after the events commit. */
export type SessionEffect =
  /** The session went Idle: stop its Harness after `EngineConfig.idleTimeout`. */
  | "scheduleIdleStop"
  /** The idle timer fired and the session went Dormant: stop its Harness now. */
  | "stopHarness"
  /** The deferred input lane waits outside the reactor lock, then signals delivery again. */
  | { readonly type: "waitForTurn"; readonly turnId: TurnId };

export type Emitted =
  | { readonly type: "domain"; readonly event: DomainEvent }
  | { readonly type: "rejected"; readonly reason: string }
  | { readonly type: "effect"; readonly effect: SessionEffect };

const EMITTED: ReadonlySet<string> = new Set<Emitted["type"]>(["domain", "rejected", "effect"]);

/** What the machine emits is ours: every `enq.emit` here passes an `Emitted`. */
export const isEmitted = (event: EventObject): event is Emitted => EMITTED.has(event.type);

export const normalizedInput = (input: SessionInput, at: string) => {
  if (input.type === "idle.timeout")
    return { ...input, backgroundExpired: input.backgroundExpired ?? false, at: input.at ?? at };

  if (input.type === "daemon.recover")
    return { ...input, stoppedFor: input.stoppedFor ?? input.cause };

  if (input.type === "harness.approvalWithdrawn")
    return {
      ...input,
      withdrawnBy: input.withdrawnBy ?? "harness",
      reason: input.reason ?? "The Harness withdrew the request",
    };

  return input.type === "harness.turnEnded" ? { ...input, limit: input.limit ?? null } : input;
};
