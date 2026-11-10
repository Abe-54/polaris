import { type AttemptId, type ConstellationId, ConstellationResult } from "@polaris/protocol";
import { Effect } from "effect";
import type { ConstellationBinding } from "../engine/constellation.inputs.ts";
import { EventStore } from "../store/EventStore.ts";
import { finding, refusal } from "./decision.ts";
import { ConstellationRuntime } from "./runtime.ts";
import { RemoteWorkers } from "./transfers/assignments.ts";

/** `constellation.worker.start`: only the user restarts a stalled worker's startup on its Host. */
export const startWorker = Effect.fnUntraced(function* (
  binding: ConstellationBinding,
  constellationId: ConstellationId,
  attemptId: AttemptId
) {
  const store = yield* EventStore;
  const record = (yield* store.model).constellations.get(constellationId);
  const attempt = record?.graph.attempts.find((a) => a.id === attemptId);

  if (binding.kind !== "user")
    return yield* refusal(record, [
      finding("E-AUTHORITY", "Only the user starts a worker this way", "Message the worker."),
    ]);

  const local = (yield* ConstellationRuntime).restartStartup;
  const remote = (yield* RemoteWorkers).restartStartup;

  // A worker on a remote worker Host is in this Host's assignments, not its graphs.
  const started =
    (attempt !== undefined && local !== undefined && (yield* local(attempt.id))) ||
    (remote !== undefined && (yield* remote(attemptId)));

  if (!started)
    return yield* refusal(record, [
      finding(
        "E-NOT-STALLED",
        `${attempt?.taskId ?? attemptId} has no startup to restart on this host`,
        "It already started its first turn, or its startup failed: stop it and dispatch again."
      ),
    ]);

  return new ConstellationResult({
    summary: `Starting ${attempt?.taskId ?? attemptId}`,
    next: "",
    revision: record?.graph.revision ?? 0,
    sequence: null,
  });
});
