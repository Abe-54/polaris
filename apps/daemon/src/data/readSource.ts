/** Refresh pending approval metadata, then resolve the exact target used by the read. */
import type { SessionId } from "@polaris/protocol";
import { Effect } from "effect";
import type { DataSources } from "./index.ts";
import type { DataAgentContext } from "./approvalRequired.ts";

type Sources = Pick<DataSources["Service"], "list" | "resolve" | "refresh">;

// DF makes refresh required when its source-watch publication lands.
const refreshApprovalSources = (sources: Sources, sessionId: SessionId) =>
  (sources.refresh ?? sources.list)({ sessionId });

export const resolveReadSource = Effect.fnUntraced(function* (
  sources: Sources,
  input: { sessionId: SessionId; source: string } & DataAgentContext
) {
  const resolved = yield* sources.resolve(input);

  if (input.tool === undefined || resolved.source.access !== "needs-approval") return resolved;
  yield* refreshApprovalSources(sources, input.sessionId);

  return yield* sources.resolve(input);
});
