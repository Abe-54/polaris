import { expect } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connectRpc, socketTransport } from "@polaris/client";
import { DomainEvent, PredictionError, Workspace, WorkspaceId } from "@polaris/protocol";
import { Effect, Layer, Redacted } from "effect";
import { EventStore } from "../store/EventStore.ts";
import { startServer } from "../transport/server.ts";
import { lazyLanguageHandlers } from "../transport/lazyLanguages.ts";
import { posixTest } from "../platform/testing.ts";
import { scopedTempDir } from "../platform/tempDir.testing.ts";

const languageHostTest = posixTest(
  "Windows Hosts have no LanguagePlatform, so language services report unsupported-platform (ENG-296)"
);

const hello = (proof = false) => {
  const input = {
    clientName: "prediction-test",
    clientVersion: "0",
    deviceLabel: "fixture",
    capabilities: ["prediction.context" as const],
  };

  return proof ? { ...input, languageProof: Redacted.make("a".repeat(64)) } : input;
};

function expectPredictionUnloaded() {
  if (process.env.POLARIS_TCTX_LAZY_PROBE !== "1") return;
  expect(
    Object.keys(require.cache).filter((path) =>
      /prediction\/(context|assemble|outline)\.ts|ast-grep/.test(path)
    )
  ).toEqual([]);
}

languageHostTest(
  "lazy prediction RPC requires authenticated connection and registered paths, works before Trust without LSP",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* scopedTempDir("predict-rpc-", { short: true });

          const workspacePath = join(root, "workspace");
          yield* Effect.promise(async () => {
            await mkdir(workspacePath);
            await writeFile(
              join(workspacePath, "file.ts"),
              'import { answer } from "./dep";\nanswer('
            );
            await writeFile(
              join(workspacePath, "dep.ts"),
              "export function answer(input: number): string { return 'private body'; }"
            );
            await writeFile(join(root, "outside.ts"), "export const forbidden = 42;");
            await symlink(join(root, "outside.ts"), join(workspacePath, "escape.ts"));
          });
          const store = yield* EventStore;
          const workspaceId = WorkspaceId.make("prediction-workspace");
          yield* store.commit({
            commandId: null,
            decide: () =>
              Effect.succeed([
                DomainEvent.cases.WorkspaceRegistered.make({
                  workspace: new Workspace({
                    id: workspaceId,
                    path: workspacePath,
                    name: "Prediction fixture",
                    isGitRepo: false,
                    worktreeRoot: join(root, "trees"),
                    hidden: false,
                    registeredAt: new Date().toISOString(),
                  }),
                }),
              ]),
          });

          const server = yield* startServer({
            root,
            socketPath: join(root, "d.sock"),
            lockPath: join(root, "d.lock"),
            capabilities: ["prediction.context"],
            handlers: lazyLanguageHandlers.pipe(Layer.provide(Layer.succeed(EventStore)(store))),
          });

          const input = {
            workspaceId,
            path: "file.ts",
            buffer: 'import { answer } from "./dep";\nanswer(',
            cursor: 37,
            recentEdits: [],
            budgetTokens: 2048,
          };

          const owned = yield* connectRpc(yield* socketTransport(server.socketPath));
          yield* owned.client.hello(hello(true));
          expectPredictionUnloaded();
          yield* owned.client["languages.host.processBudget.get"]({});
          expectPredictionUnloaded();

          const absent = yield* connectRpc(yield* socketTransport(server.socketPath));
          yield* absent.client.hello(hello());
          expect(yield* Effect.flip(absent.client["prediction.context"](input))).toBeInstanceOf(
            PredictionError
          );
          const pieces = yield* owned.client["prediction.context"](input);
          expect(pieces.map((piece) => piece.kind)).toEqual(["importOutline"]);
          expect(pieces[0]?.text).toContain("answer(input: number): string;");
          expect(pieces[0]?.text).not.toContain("private body");

          if (process.env.POLARIS_TCTX_LAZY_PROBE === "1")
            expect(
              Object.keys(require.cache).some((path) => path.includes("/prediction/outline.ts"))
            ).toBe(true);

          for (const path of ["../outside.ts", "escape.ts"]) {
            expect(
              yield* Effect.flip(owned.client["prediction.context"]({ ...input, path }))
            ).toBeInstanceOf(PredictionError);
          }

          expect(
            yield* Effect.flip(
              owned.client["prediction.context"]({
                ...input,
                workspaceId: WorkspaceId.make("unregistered"),
              })
            )
          ).toBeInstanceOf(PredictionError);
          expect(
            yield* Effect.flip(
              owned.client["prediction.context"]({ ...input, cursor: input.buffer.length + 1 })
            )
          ).toBeInstanceOf(PredictionError);

          const changed = yield* owned.client["prediction.context"]({
            ...input,
            buffer: 'import { hidden } from "./escape";',
            cursor: 0,
          });

          expect(changed).toEqual([]);
        })
      ).pipe(Effect.provide(EventStore.layerSqlite(":memory:")))
    );
  }
);
