import { expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import {
  LanguageCheckout,
  LanguageEffectiveSettings,
  LanguageFormatterSelection,
  LanguageTrust,
  WorkspaceId,
} from "@polaris/protocol";
import { artifactFixture, hostId, platform } from "../install/fixture.testing.ts";
import { TrustRecord } from "../trust/index.ts";
import { LanguageBroker } from "../runtime/index.ts";
import type { createSelectionLedger } from "../install/selection-ledger.ts";
import { HostLanguageInstallation } from "../availability/service.ts";
import { HostLanguageResources, languageHostServices } from "./host.ts";
import { posixTest } from "../../platform/testing.ts";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

const privateInstallTest = posixTest(
  "language installations require a POSIX-mode private, owned directory (ENG-314)"
);

for (const retainLease of [false, true]) {
  privateInstallTest(
    `Host scope closes broker before installation resources, retained lease=${retainLease}`,
    async () => {
      const root = newTempDir("m31-j1-host-scope-", { short: true });

      const source = artifactFixture();

      const checkout = LanguageCheckout.cases.Workspace.make({
        workspaceId: WorkspaceId.make("scope-workspace"),
        path: root,
      });

      const registry = async () => ({ checkout, workspacePath: root });

      let disposedObservations = 0;

      let contextsAtDisposal = -1;

      let broker: LanguageBroker["Service"] | undefined;

      let ledger: ReturnType<typeof createSelectionLedger> | undefined;

      let held:
        | Awaited<ReturnType<ReturnType<typeof createSelectionLedger>["reserveLaunch"]>>
        | undefined;

      await writeFile(join(root, "file.ts"), "fixture");

      const services = languageHostServices(
        {
          hostId,
          platform,
          root: join(root, "installed"),
          tools: [source.tool],
          adapters: {
            download: async function* () {
              yield source.bytes;
            },
            decode: async () => source.payload,
          },
          observe: async () => ({ connected: true, probes: [] }),
          disposeObservations: async () => {
            disposedObservations++;

            if (broker === undefined) throw new Error("Broker was never built");
            contextsAtDisposal = Effect.runSync(broker.stats).contexts;
          },
        },
        { registry },
        {
          hostId,
          registry,
          repository: {
            read: async (scope) =>
              TrustRecord.make({
                canonicalRoot: root,
                trust: LanguageTrust.make({ scope, revision: 1, trusted: true }),
              }),
            compareAndSet: async () => false,
          },
          authorizeGrant: async () => {
            throw new Error("No grant authority");
          },
        }
      );

      try {
        const result = await Effect.runPromiseExit(
          Effect.scoped(
            Effect.gen(function* () {
              broker = yield* LanguageBroker;

              const resources = yield* HostLanguageResources;

              const installation = yield* HostLanguageInstallation;
              ledger = resources.ledger;

              expect(yield* installation.current(source.tool.id)).toBeNull();

              expect(
                yield* Effect.promise(() => resources.host.current(source.tool.id))
              ).toBeNull();

              yield* broker.acquire("scope-client", {
                clientId: "scope-client",
                contextId: "scope-context",
                checkout,
                path: join(root, "file.ts"),
                providerId: "typescript-language-server",
                interestId: "scope-interest",
                settings: LanguageEffectiveSettings.make({
                  settings: {},
                  revision: 0,
                  formatOnSave: true,
                  formatter: LanguageFormatterSelection.cases.None.make({}),
                  providers: ["typescript-language-server"],
                  origins: {},
                }),
              });

              expect((yield* broker.stats).contexts).toBe(1);

              if (retainLease)
                held = yield* Effect.promise(() =>
                  resources.ledger.reserveLaunch(
                    source.tool.id,
                    `sha256:${"a".repeat(64)}`,
                    new AbortController().signal
                  )
                );
            }).pipe(Effect.provide(services))
          )
        );

        expect(Exit.isFailure(result)).toBe(retainLease);

        expect(disposedObservations).toBe(1);

        expect(contextsAtDisposal).toBe(0);

        expect(ledger?.stats()).toMatchObject({
          launches: retainLease ? 1 : 0,
          disposed: !retainLease,
        });
      } finally {
        await held?.release();
        ledger?.dispose();
        await removeTempDirSettled(root);
      }
    }
  );
}
