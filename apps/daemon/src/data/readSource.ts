/** Refresh pending approval metadata, then resolve the exact target used by the read. */
import type { SessionId } from "@polaris/protocol";
import { Effect } from "effect";
import type { DataSources } from "./index.ts";
import type { DataAgentContext } from "./approvalRequired.ts";

type Sources = Pick<DataSources["Service"], "resolve" | "refresh">;

export const resolveReadSource = Effect.fnUntraced(function* (
  sources: Sources,
  input: { sessionId: SessionId; source: string } & DataAgentContext
) {
  const resolved = yield* sources.resolve(input);

  if (input.tool === undefined || resolved.source.access !== "needs-approval") return resolved;
  yield* sources.refresh({ sessionId: input.sessionId });

  return yield* sources.resolve(input);
});
