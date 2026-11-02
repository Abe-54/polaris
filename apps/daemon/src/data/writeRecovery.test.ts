import { expect, test } from "bun:test";
import { join } from "node:path";
import { QueryLogEntry } from "@polaris/protocol";
import { Effect, Layer } from "effect";
import { DataDatabase } from "./database.ts";
import { DataApprovals } from "./approvals.ts";
import { QueryLog } from "./queryLog.ts";
import { EventStore } from "../store/EventStore.ts";
import { newTempDir, removeTempDirSettled } from "../platform/tempDir.testing.ts";

test("F14: restarting the Query Log marks unfinished agent and grid writes unknown", async () => {
  const dir = newTempDir("wf-log-");

  const layer = () =>
    QueryLog.layer.pipe(
      Layer.provide(DataApprovals.layer),
      Layer.provide(DataDatabase.layerAt(join(dir, "data.sqlite"))),
      Layer.provide(EventStore.layerSqlite(":memory:"))
    );

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const log = yield* QueryLog;

        for (const tool of ["execute", "data.edits.commit", "query"])
          yield* log.put(
            new QueryLogEntry({
              id: tool,
              checkout: "/repo",
              source: { id: "app", name: "app" },
              sql: "SQL",
              state: "running",
              tool,
              author: { kind: "user" },
              at: new Date().toISOString(),
            })
          );
      }).pipe(Effect.provide(layer()))
    );

    const page = await Effect.runPromise(
      QueryLog.use((log) => log.page("/repo")).pipe(Effect.provide(layer()))
    );

    expect(page.entries.map((entry) => [entry.tool, entry.state])).toEqual([
      ["query", "running"],
      ["data.edits.commit", "unknown"],
      ["execute", "unknown"],
    ]);
    expect(page.entries.find((entry) => entry.tool === "execute")?.error).toContain(
      "Check the rows before retrying"
    );
  } finally {
    await removeTempDirSettled(dir);
  }
});
