/** Snapshot the real projection and committed events; traces contain no test-authored phase labels. */
import { Effect } from "effect";
import { DataApprovals } from "./approvals.ts";
import { QueryLog } from "./queryLog.ts";
import { EventStore } from "../store/EventStore.ts";
import { writeRequestKey } from "./writeIdentity.ts";
import {
  DataWriteTrace,
  DataWriteTraceStep,
} from "../../../../packages/spec/scripts/data-write-replay/index.ts";
import { Schema } from "effect";

export const observeWrite = Effect.fnUntraced(function* (
  input: Parameters<typeof writeRequestKey>[0],
  observation: { affected: number; value: number; external?: number; identity?: string }
) {
  const approvals = yield* DataApprovals;
  const record = yield* approvals.writes.lookup(writeRequestKey(input)!);

  if (!record?.request.dataWrite) throw new Error("Missing persisted write request");
  const store = yield* EventStore;
  const model = yield* store.model;
  const checkout = model.sessions.get(input.sessionId)!.session.cwd;
  const logs = yield* (yield* QueryLog).page(checkout);

  const events = yield* store.readEvents({
    after: 0,
    upTo: Number.MAX_SAFE_INTEGER,
    sessionId: input.sessionId,
  });

  return Schema.decodeUnknownSync(DataWriteTraceStep)({
    request: record.request,
    status: record.status,
    log: logs.entries.find((entry) => entry.id === record.request.dataWrite!.queryId) ?? null,
    events,
    ...observation,
    external: observation.external ?? 0,
    identity: observation.identity ?? record.request.dataWrite.identity ?? "",
  });
});

export async function saveWriteTrace(name: string, steps: typeof DataWriteTrace.Type.steps) {
  const trace = Schema.decodeUnknownSync(DataWriteTrace)({
    version: 2,
    source: "data-queries-write",
    steps,
  });

  if (process.env.POLARIS_DATA_WRITE_TRACE_DIR)
    await Bun.write(
      `${process.env.POLARIS_DATA_WRITE_TRACE_DIR}/${name}.json`,
      JSON.stringify(trace, null, 2)
    );

  return trace;
}
