import { Context, Schema, type Effect, type Stream } from "effect";
import {
  RequestId,
  type HttpMethod,
  type RequestsError,
  type SessionId,
  type TurnId,
} from "@polaris/protocol";
import type { OriginOutcome, OriginRule } from "./store.ts";

/** Internal handoff: the agent's Send waits on this Origin Approval; never an RPC failure. */
export class OriginApprovalRequired extends Schema.TaggedError<OriginApprovalRequired>()(
  "OriginApprovalRequired",
  { approvalId: RequestId, origin: Schema.String }
) {}

/** What an agent's Send carries into the gate; never a secret's value. */
export interface AgentSend {
  readonly url: string;
  readonly method: HttpMethod;
  /** The variable the URL's origin came from, and the environment it was resolved in. */
  readonly variable?: string;
  readonly environment?: string;
  readonly tokenSource?: { readonly file: string; readonly name: string };
}

export interface AgentSendContext {
  readonly turn?: TurnId;
  /** The approval an earlier attempt waited on: spends its one-Send grant. */
  readonly approvalId?: RequestId;
}

export class OriginApprovals extends Context.Service<
  OriginApprovals,
  {
    readonly changes: Stream.Stream<void>;
    /** Lets an agent's Send through, or raises (or joins) its origin's pending approval. */
    readonly require: (
      sessionId: SessionId,
      send: AgentSend,
      context?: AgentSendContext
    ) => Effect.Effect<void, RequestsError | OriginApprovalRequired>;
    readonly awaitApproval: (
      id: RequestId,
      write: boolean,
      timeoutMs: number
    ) => Effect.Effect<OriginOutcome, RequestsError>;
    readonly rules: Effect.Effect<ReadonlyArray<OriginRule>, RequestsError>;
    readonly revoke: (origin: string) => Effect.Effect<void, RequestsError>;
  }
>()("polaris/requests/OriginApprovals") {}
