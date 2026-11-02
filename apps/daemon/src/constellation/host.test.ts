import { expect, test } from "bun:test";
import { join } from "node:path";
import { DomainEvent } from "@polaris/protocol";
import { Effect, Layer } from "effect";
import { CID, LEAD } from "../engine/constellation.testing.ts";
import { McpBinding, McpTokens } from "../mcp/index.ts";
import { HostResources } from "../resources/index.ts";
import { EventStore } from "../store/EventStore.ts";
import { ConstellationOwner } from "./runtime.ts";
import { HOST } from "../engine/constellation.testing.ts";
import { hostWorkingAttemptsLayer } from "./host.ts";
import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";

test("Host composition captures persistent MCP tokens and revokes archived sessions on replay", async () => {
  const dir = newTempDir("c1-host-hooks-");

  const resources = HostResources.of({
    get: Effect.die("unused"),
    declare: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    release: () => Effect.die("unused"),
    setWorkerCap: () => Effect.die("unused"),
    acquire: () => Effect.die("unused"),
    acquireWorker: () => Effect.void,
  });

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* EventStore;
          const tokens = yield* McpTokens;

          const credential = yield* tokens.issue(
            McpBinding.cases.Lead.make({ sessionId: LEAD, constellationId: CID })
          );

          yield* store.commit({
            commandId: null,
            decide: () =>
              Effect.succeed([
                DomainEvent.cases.SessionStateChanged.make({
                  sessionId: LEAD,
                  state: "archived",
                  reason: null,
                }),
              ]),
          });
          yield* Layer.build(
            hostWorkingAttemptsLayer({
              runtime: {
                prepare: () =>
                  Effect.succeed({
                    attempts: [],
                    newLeadSessionId: null,
                    claimProbe: null,
                    recordedChecks: [],
                  }),
                afterCommit: () => Effect.void,
                resumeWorking: () => Effect.void,
              },
              startWorker: () => Effect.void,
              resumeWorker: () => Effect.void,
              failed: () => Effect.void,
            }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(EventStore)(store),
                  Layer.succeed(ConstellationOwner)(HOST),
                  Layer.succeed(McpTokens)(tokens),
                  Layer.succeed(HostResources)(resources)
                )
              )
            )
          );
          expect(yield* tokens.authenticate(credential)).toBeNull();
        })
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            EventStore.layerSqlite(":memory:"),
            McpTokens.layer(join(dir, "tokens.sqlite"))
          )
        )
      )
    );
  } finally {
    removeTempDir(dir);
  }
});
