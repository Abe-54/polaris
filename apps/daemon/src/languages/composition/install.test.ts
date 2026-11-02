import { expect } from "bun:test";
import { Effect, Layer, Stream } from "effect";
import { LanguageConnectionIdentity } from "@polaris/protocol";
import { EventStore } from "../../store/EventStore.ts";
import { CurrentLanguageConnection } from "../../transport/currentLanguageConnection.ts";
import {
  ConnectionLanguageLifetime,
  LanguageConnectionLifetime,
} from "../../transport/languageConnectionLifetime.ts";
import { createHostInstallations } from "../install/host.ts";
import { artifactFixture, hostId, platform } from "../install/fixture.testing.ts";
import { LanguageInstallCore, LanguageInstallGrantAuthority } from "./install.ts";
import { posixTest } from "../../platform/testing.ts";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

const privateInstallTest = posixTest(
  "language installations require a POSIX-mode private, owned directory (ENG-314)"
);

privateInstallTest(
  "composition maps pinned install intent and scopes progress to independent connection ownership",
  async () => {
    const root = newTempDir("m31-install-composition-", { short: true });
    const registry = createHostInstallations();
    const source = artifactFixture();
    const original = LanguageConnectionIdentity.make({ hostId, clientId: "fake-client" });
    let current = original;
    let grants = 0;
    let downloads = 0;
    const lifetime = new ConnectionLanguageLifetime(() => current);

    try {
      const host = await registry.get({
        hostId,
        platform,
        root,
        tools: [source.tool],
        adapters: {
          download: async function* () {
            downloads++;
            yield source.bytes;
          },
          decode: async () => source.payload,
          approve: async (exact) => ({ identity: exact.identity, approved: true }),
        },
        observe: async () => ({ connected: true, probes: [] }),
        reserveSelection: async () => ({ validate: async () => {}, release: async () => {} }),
      });

      const services = LanguageInstallCore.layer(hostId, host).pipe(
        Layer.provide(
          Layer.succeed(LanguageInstallGrantAuthority)({
            authorize: (principal) =>
              Effect.sync(() => {
                expect(principal).toBe(current);
                grants++;
              }),
          })
        )
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const core = yield* LanguageInstallCore;

          const job = yield* core.start({
            toolId: source.tool.id,
            version: source.tool.version,
            intent: "manual",
          });

          const progress = yield* Stream.runCollect(core.watch(job.jobId));
          expect(progress.at(-1)?.phase).toBe("completed");
          expect(downloads).toBe(1);
          yield* core.cancel(job.jobId);
          const replay = yield* Stream.runCollect(core.watch(job.jobId));
          expect(replay.at(-1)?.phase).toBe("completed");
          expect(grants).toBeGreaterThan(2);
          current = LanguageConnectionIdentity.make(original);
          const foreign = yield* Effect.flip(Stream.runCollect(core.watch(job.jobId)));
          expect(foreign.reason).toBe("not-owner");
          yield* lifetime.close();
        }).pipe(
          Effect.scoped,
          Effect.provide(services),
          Effect.provideService(CurrentLanguageConnection, { current: () => current }),
          Effect.provideService(LanguageConnectionLifetime, { attach: lifetime.attach }),
          Effect.provide(EventStore.layerSqlite(":memory:"))
        )
      );
    } finally {
      await registry.dispose();
      await removeTempDirSettled(root);
    }
  }
);
