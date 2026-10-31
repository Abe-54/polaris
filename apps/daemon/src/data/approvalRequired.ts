/** Internal approval handoff; never serialized as an RPC failure. */
import { RequestId, type SessionId, type TurnId } from "@polaris/protocol";
import { Schema } from "effect";

export class DataApprovalRequired extends Schema.TaggedError<DataApprovalRequired>()(
  "DataApprovalRequired",
  { approvalId: RequestId, sourceId: Schema.String, sourceName: Schema.String }
) {}

export type DataApprovalOutcome =
  | { readonly status: "approved" }
  | { readonly status: "denied"; readonly reason: string }
  | { readonly status: "pending" };

export interface DataAgentContext {
  readonly turn?: TurnId;
  readonly tool?: "describe" | "query" | "execute";
}

export interface OutsideInput {
  readonly sessionId: SessionId;
  readonly turn: TurnId;
  readonly source: string;
  readonly command: string;
  readonly itemId: string;
}
