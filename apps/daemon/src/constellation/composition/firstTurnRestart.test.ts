import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  CommandId,
  DomainEvent,
  type SessionId,
  TurnId,
  WorktreeSetupRun,
} from "@polaris/protocol";
import { Effect } from "effect";
import { A, AT, CID } from "../../engine/constellation.testing.ts";
import { EventStore } from "../../store/EventStore.ts";
import { setup } from "../delivery/testing.ts";
import { sendbackWorld } from "../../mcp/sendback.testing.ts";
import { restartForRetry } from "../../mcp/sendback.restart.testing.ts";
import { startPendingAttempt } from "./workers.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

const setupCard = (sessionId: SessionId, status: "running" | "completed") =>
  DomainEvent.cases.SessionSetupChanged.make({
    sessionId,
    setup: new WorktreeSetupRun({
      id: "dispatch:setup:1",
      constellationId: CID,
      taskId: A,
      command: "bun install",
      cwd: "/tmp",
      status,
      output: "",
      exitCode: status === "completed" ? 0 : null,
      startedAt: AT,
      endedAt: status === "completed" ? AT : null,
    }),
  });

// ENG-263: setup finished, the worker sat Dormant with no Turn, then the Daemon restarted.
for (const started of [false, true])
  test(`restart after setup completed ${started ? "and the first Turn started keeps one first Turn" : "and before the first Turn starts that Turn once"}`, async () => {
    const root = newTempDir("polaris-first-turn-", { short: true });
    const file = join(root, "state.sqlite");

    try {
      const attempt = await sendbackWorld(file, started).run(
        Effect.gen(function* () {
          yield* setup();
          const store = yield* EventStore;
          const initial = (yield* store.model).constellations.get(CID)!.graph.attempts[0]!;
          yield* store.commit({
            commandId: null,
            decide: () =>
              Effect.succeed([
                setupCard(initial.sessionId, "running"),
                setupCard(initial.sessionId, "completed"),
              ]),
          });
          const turns = (yield* store.model).sessions.get(initial.sessionId)!.turns;
          expect(turns.map((t) => t.id)).toEqual(
            started ? [TurnId.make(`${initial.id}:start`)] : []
          );

          return initial;
        })
      );

      const turn = await restartForRetry(root, attempt, undefined, !started);
      expect(turn.id).toBe(TurnId.make(`${attempt.id}:start`));

      const resumed = sendbackWorld(file, false);
      await resumed.run(
        Effect.gen(function* () {
          const store = yield* EventStore;
          const graph = (yield* store.model).constellations.get(CID)!.graph;
          expect(yield* startPendingAttempt(graph, attempt)).toBe(false);
          expect(yield* store.hasCommandReceipt(CommandId.make(`${attempt.id}:start`))).toBe(true);
          const turns = (yield* store.model).sessions.get(attempt.sessionId)!.turns;
          expect(turns.map((t) => t.id)).toEqual([TurnId.make(`${attempt.id}:start`)]);
          expect(resumed.turns).toHaveLength(0);
        })
      );
    } finally {
      removeTempDir(root);
    }
  }, 20000);
