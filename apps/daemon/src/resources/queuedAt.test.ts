import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { DomainEvent, HostId, SessionId } from "@polaris/protocol";
import { Effect, Predicate } from "effect";
import { EventStore } from "../store/EventStore.ts";
import { WORKERS_RESOURCE } from "./model.ts";
import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";

const dirs: Array<string> = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempDir(dir);
});

test("a queued worker request keeps when it joined the queue, live and after a restart", async () => {
  const dir = newTempDir("queued-at-", { short: true });
  dirs.push(dir);
  const filename = join(dir, "state.sqlite");

  const committedAt = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* EventStore;

      const result = yield* store.commit({
        commandId: null,
        decide: () =>
          Effect.succeed([
            DomainEvent.cases.ResourceLeaseQueued.make({
              hostId: HostId.make("host"),
              resource: WORKERS_RESOURCE,
              requestId: "r1",
              sessionId: SessionId.make("worker"),
            }),
          ]),
      });

      if (!Predicate.isTagged(result, "Committed")) throw new Error("not committed");
      const occurredAt = result.envelopes[0]!.occurredAt;

      expect((yield* store.model).hostResources?.waiting.get("r1")?.queuedAt).toBe(occurredAt);

      return occurredAt;
    }).pipe(Effect.provide(EventStore.layerSqlite(filename)))
  );

  const reloaded = await Effect.runPromise(
    Effect.gen(function* () {
      return (yield* (yield* EventStore).model).hostResources?.waiting.get("r1")?.queuedAt;
    }).pipe(Effect.provide(EventStore.layerSqlite(filename)))
  );

  expect(reloaded).toBe(committedAt);
});
