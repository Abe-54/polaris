import { Context, Effect, Layer, type Stream } from "effect";
import type { DataSource, DataError, SessionId, TurnId, RequestId } from "@polaris/protocol";
import type { WriteApprovals } from "./writeApprovals.ts";
import type { DataApprovalRequired, DataApprovalOutcome } from "./approvalRequired.ts";

export class DataApprovals extends Context.Service<
  DataApprovals,
  {
    readonly changes: Stream.Stream<void>;
    readonly writes: WriteApprovals;
    readonly read: (
      source: DataSource
    ) => Effect.Effect<{ access: DataSource["access"]; writes: DataSource["writes"] }, DataError>;
    readonly require: (
      sessionId: SessionId,
      source: DataSource,
      turn?: TurnId,
      approvalId?: RequestId
    ) => Effect.Effect<void, DataError | DataApprovalRequired>;
    readonly awaitApproval: (
      id: RequestId,
      timeoutMs: number
    ) => Effect.Effect<DataApprovalOutcome, DataError>;
    readonly change: (
      source: DataSource,
      writes?: DataSource["writes"],
      revoke?: boolean
    ) => Effect.Effect<void, DataError>;
  }
>()("polaris/data/Approvals") {
  static readonly layer = Layer.unwrap(
    Effect.promise(() => import("./approvals.ts")).pipe(
      Effect.map((module) => module.dataApprovalsLayer)
    )
  );
}
