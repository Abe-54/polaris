import { expect } from "bun:test";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { connectRpc, socketTransport } from "@polaris/client";
import { LanguageError } from "@polaris/protocol";
import { Effect, Layer, Predicate, Redacted, Stream } from "effect";
import { EventStore } from "../../store/EventStore.ts";
import { startServer } from "../../transport/server.ts";
import { DefaultLanguageHostHandlers } from "./defaults.ts";
import { posixTest } from "../../platform/testing.ts";
import { scopedTempDir } from "../../platform/tempDir.testing.ts";

const languageHostTest = posixTest(
  "Windows Hosts have no LanguagePlatform, so language services report unsupported-platform (ENG-296)"
);

const hello = (languageProof?: Redacted.Redacted<unknown>) => {
  const input = {
    clientName: "fake-core",
    clientVersion: "0",
    deviceLabel: "fixture",
    capabilities: [],
  };

  return languageProof === undefined ? input : { ...input, languageProof };
};

languageHostTest(
  "mounted Host core uses transport Host identity and refuses unapproved managed ShellCheck",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* scopedTempDir("m31-core-mount-", { short: true });

          const store = yield* EventStore;

          const server = yield* startServer({
            root,
            socketPath: join(root, "d.sock"),
            lockPath: join(root, "d.lock"),
            handlers: DefaultLanguageHostHandlers.pipe(
              Layer.provide(Layer.succeed(EventStore)(store))
            ),
          });

          const absent = yield* connectRpc(yield* socketTransport(server.socketPath));

          yield* absent.client.hello(hello());

          const denied = yield* Effect.flip(absent.client["languages.catalog"]({}));

          expect(denied).toBeInstanceOf(LanguageError);

          expect(denied.reason).toBe("not-owner");

          const budgetDenied = yield* Effect.flip(
            absent.client["languages.host.processBudget.get"]({})
          );

          expect(budgetDenied.reason).toBe("not-owner");

          const owned = yield* connectRpc(yield* socketTransport(server.socketPath));

          const reply = yield* owned.client.hello(hello(Redacted.make("e".repeat(64))));

          const catalog = yield* owned.client["languages.catalog"]({});

          const hostState = yield* owned.client["languages.host.state"]({
            toolIds: [],
            refresh: true,
          });

          expect(hostState.hostId).toBe(reply.host.hostId);
          expect(hostState.tools).toHaveLength(catalog.tools.length);
          const budget = yield* owned.client["languages.host.processBudget.get"]({});
          expect(budget.hostId).toBe(reply.host.hostId);
          expect(budget.maxProcesses).toBeNull();

          const selected = yield* owned.client["languages.host.processBudget.set"]({
            expectedRevision: budget.revision,
            maxProcesses: 12,
          });

          expect(selected.effectiveLimit).toBe(12);

          const raced = yield* Effect.flip(
            owned.client["languages.host.processBudget.set"]({
              expectedRevision: budget.revision,
              maxProcesses: 16,
            })
          );

          expect(raced.reason).toBe("conflict");

          const state = hostState.tools.find(
            (tool) => tool.toolId === "typescript-language-server"
          )?.state;

          expect(state !== undefined && Predicate.isTagged(state, "NotDownloaded")).toBe(true);
          expect(
            catalog.integrations
              .filter((integration) => integration.offered)
              .map((integration) => integration.id)
          ).toEqual([
            "typescript",
            "json",
            "html",
            "css",
            "python",
            "bash",
            "php",
            "go",
            "rust",
            "lua",
            "sql",
            "prisma",
            "yaml",
            "actions",
            "svelte",
          ]);

          const feed = yield* Stream.runCollect(
            owned.client["languages.host.state.watch"]({
              toolIds: ["typescript-language-server"],
              refresh: false,
            }).pipe(Stream.take(1))
          );

          expect(feed[0]?.tools.map((tool) => tool.toolId)).toEqual(["typescript-language-server"]);

          const shellcheck = catalog.tools.find((tool) => tool.id === "shellcheck");

          expect(shellcheck?.disposition).toBe("offered");

          expect(shellcheck?.artifacts).toHaveLength(4);

          const facts = yield* owned.client["languages.availability"]({
            toolIds: ["shellcheck"],
            checkout: null,
            phase: "install",
            refresh: true,
          });

          expect(facts).toHaveLength(1);

          expect(facts[0]?.hostId).toBe(reply.host.hostId);

          const fact = facts[0];

          if (fact === undefined || !Predicate.isTagged(fact.preflight, "Blocked"))
            throw new Error("Pending artifact was not blocked");

          expect(Predicate.isTagged(fact.installation, "NotInstalled")).toBe(true);
          expect(fact.preflight.reason).toBe("audit-required");

          const unobserved = yield* Effect.flip(
            owned.client["languages.availability"]({
              toolIds: ["typescript-language-server"],
              checkout: null,
              phase: "install",
              refresh: true,
            })
          );

          expect(unobserved.reason).toBe("not-ready");
          expect(unobserved.message).toBe(
            "Prerequisite observation is unavailable without current request authority"
          );

          const installDenied = yield* Effect.flip(
            owned.client["languages.install"]({
              toolId: "shellcheck",
              version: "0.11.0",
              intent: "manual",
            })
          );

          expect(installDenied.reason).toBe("unsupported-capability");
          expect(installDenied.message).toBe("Independent installation permission is unavailable");

          const foreignCancel = yield* Effect.flip(
            owned.client["languages.install.cancel"]({ jobId: "foreign-job" })
          );

          expect(foreignCancel.reason).toBe("not-owner");

          const rollbackDenied = yield* Effect.flip(
            owned.client["languages.install"]({
              toolId: "shellcheck",
              version: "0.11.0",
              intent: "rollback",
            })
          );

          expect(rollbackDenied.reason).toBe("unsupported-capability");

          const foreignWatch = yield* Effect.flip(
            Stream.runCollect(owned.client["languages.install.watch"]({ jobId: "foreign-job" }))
          );

          expect(foreignWatch.reason).toBe("not-owner");

          yield* Effect.promise(() => access(join(root, "languages")));

          expect(reply.capabilities).not.toContain("languages");
        })
      ).pipe(Effect.provide(EventStore.layerSqlite(":memory:")))
    );
  }
);
