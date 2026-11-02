import { expect, test } from "bun:test";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as P from "@polaris/protocol";
import { Effect, Layer, Predicate, Redacted, Schema } from "effect";
import { connectRpc, socketTransport } from "@polaris/client";
import { EventStore } from "../../store/EventStore.ts";
import { startServer } from "../../transport/server.ts";
import { lazyLanguageHandlers } from "../../transport/lazyLanguages.ts";
import { scopedTempDir } from "../../platform/tempDir.testing.ts";

const caps: P.Capability[] = [
  "languages",
  "languages.trust",
  "languages.format",
  "languages.buffer-acknowledgments",
  "languages.edit-preparation",
];

/** Real pinned servers, default Host composition and authenticated RPC; the interpreter is a hostile sentinel. */
test("Python providers run without Trust, preserve drafts on selection, and never execute the interpreter", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* scopedTempDir("polaris-python-live-", { short: true });

        const project = join(root, "project");
        const file = join(project, "a.py");
        const marker = join(root, "executed");
        yield* Effect.promise(async () => {
          await mkdir(join(project, ".venv/bin"), { recursive: true });
          await writeFile(join(project, "uv.lock"), "version = 1\n");
          await writeFile(
            join(project, "pyproject.toml"),
            '[project]\nname = "fixture"\nversion = "0.1.0"\n[tool.uv]\n'
          );
          await writeFile(join(project, "value.py"), "def answer() -> int:\n    return 42\n");
          await writeFile(file, "saved = 1\n");

          for (const name of ["python", "other-python"]) {
            const executable = join(project, ".venv/bin", name);
            await writeFile(executable, `#!/bin/sh\ntouch '${marker}'\nexit 99\n`);
            await chmod(executable, 0o755);
          }
        });
        const workspaceId = P.WorkspaceId.make("python-fixture");
        const store = yield* EventStore;
        yield* store.commit({
          commandId: null,
          decide: () =>
            Effect.succeed([
              P.DomainEvent.cases.WorkspaceRegistered.make({
                workspace: new P.Workspace({
                  id: workspaceId,
                  path: project,
                  name: "fixture",
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
          capabilities: caps,
          handlers: lazyLanguageHandlers.pipe(Layer.provide(Layer.succeed(EventStore)(store))),
        });

        const rpc = yield* connectRpc(yield* socketTransport(server.socketPath));

        const hello = yield* rpc.client.hello({
          clientName: "python-proof",
          clientVersion: "0",
          deviceLabel: "isolated",
          capabilities: caps,
          languageProof: Redacted.make("f".repeat(64)),
        });

        if (hello.languageIdentity === undefined)
          throw new Error("Authenticated identity unavailable");
        const checkout = P.LanguageCheckout.cases.Workspace.make({ workspaceId, path: project });

        const settings = P.LanguageEffectiveSettings.make({
          revision: 0,
          formatOnSave: true,
          formatter: P.LanguageFormatterSelection.cases.Provider.make({ providerId: "ruff" }),
          providers: [],
          origins: {},
          settings: {},
        });

        const discovered = yield* rpc.client["languages.discover"]({
          checkout,
          path: file,
          documentLanguageId: "python",
          settings,
        });

        console.log("discovery", JSON.stringify(discovered.providers));
        expect(discovered.providers.map((provider) => provider.preflight._tag)).toEqual([
          "Eligible",
          "Eligible",
        ]);
        const draft = "import os\nfrom value import answer\nbad: str = answer()\nresult=answer()\n";
        const uri = pathToFileURL(file).href;
        const snapshots = [];

        for (const providerId of ["basedpyright", "ruff"]) {
          const input = {
            clientId: hello.languageIdentity.clientId,
            contextId: providerId,
            checkout,
            path: file,
            providerId,
            settings,
            interestId: "file",
          };

          let snapshot = yield* rpc.client["languages.context.acquire"](input);
          yield* rpc.client["languages.document.sync"]({
            context: snapshot.context,
            sequence: 1,
            notification: P.LanguageDocumentNotification.cases.Open.make({
              uri,
              languageId: "python",
              version: 1,
              text: draft,
            }),
          });

          for (let i = 0; i < 600 && !Predicate.isTagged(snapshot.runtime, "Ready"); i++) {
            yield* Effect.sleep("20 millis");
            snapshot = yield* rpc.client["languages.context.acquire"](input);

            if (Predicate.isTagged(snapshot.runtime, "Failed"))
              throw new Error(snapshot.runtime.message);
          }

          console.log("runtime", providerId, JSON.stringify(snapshot));
          expect(Predicate.isTagged(snapshot.runtime, "Ready")).toBe(true);
          snapshots.push(snapshot);
        }

        const primary = snapshots[0]!;
        const lint = snapshots[1]!;

        const fence = (snapshot: typeof P.AcquireLanguageContext.successSchema.Type) =>
          P.LanguageRequestFence.make({
            context: snapshot.context,
            requiredSequence: snapshot.ack.acceptedSequence,
            documents: [{ uri, version: 1 }],
          });

        for (const snapshot of snapshots) {
          const diagnostic = yield* rpc.client["languages.request"]({
            requestId: "diagnostics",
            fence: fence(snapshot),
            method: "textDocument/diagnostic",
            params: { textDocument: { uri } },
            deadline: Date.now() + 15000,
          });

          expect(JSON.stringify(diagnostic.result)).toContain(
            snapshot.context.providerId === "ruff" ? "F401" : "reportAssignmentType"
          );
          console.log(
            "diagnostics",
            snapshot.context.providerId,
            JSON.stringify(diagnostic.result)
          );
        }

        for (const method of [
          "textDocument/hover",
          "textDocument/definition",
          "textDocument/references",
          "textDocument/rename",
          "textDocument/completion",
        ] as const) {
          const result = yield* rpc.client["languages.request"]({
            requestId: method.split("/")[1]!,
            fence: fence(primary),
            method,
            params: {
              textDocument: { uri },
              position: { line: 3, character: 9 },
              newName: "renamed",
              context: { includeDeclaration: true },
            },
            deadline: Date.now() + 15000,
          });

          expect(result.result).not.toBeNull();

          verifyFeature(method, result.result);
        }

        const actions = yield* rpc.client["languages.request"]({
          requestId: "actions",
          fence: fence(lint),
          method: "textDocument/codeAction",
          params: {
            textDocument: { uri },
            range: { start: { line: 0, character: 0 }, end: { line: 4, character: 0 } },
            context: { diagnostics: [], only: ["source.fixAll.ruff"] },
          },
          deadline: Date.now() + 15000,
        });

        expect(
          Schema.decodeUnknownSync(Schema.Array(Schema.Json))(actions.result).length
        ).toBeGreaterThan(0);

        const formatted = yield* rpc.client["languages.format"]({
          requestId: "format",
          reason: "manual",
          expectedDiskVersion: { mtimeMs: 0, size: 0, hash: "0".repeat(64) },
          fence: fence(lint),
          document: { uri, version: 1 },
          snapshot: draft,
          formatter: P.LanguageFormatterSelection.cases.Provider.make({ providerId: "ruff" }),
          options: { tabSize: 4, insertSpaces: true },
          deadline: Date.now() + 15000,
        });

        expect(Predicate.isTagged(formatted, "Formatted")).toBe(true);
        console.log("format", JSON.stringify(formatted));

        const selected = yield* rpc.client["languages.python.select"]({
          checkout,
          path: file,
          interpreter: join(project, ".venv/bin/other-python"),
          expectedRevision: 0,
        });

        expect(selected.revision).toBe(1);

        const replacement = yield* rpc.client["languages.context.acquire"]({
          clientId: hello.languageIdentity.clientId,
          contextId: "basedpyright",
          checkout,
          path: file,
          providerId: "basedpyright",
          settings,
          interestId: "file",
        });

        expect(replacement.context.generation).toBeGreaterThan(primary.context.generation);
        expect(replacement.ack.documents).toEqual([{ uri, version: 1 }]);
        expect(replacement.ack.acceptedSequence).toBe(primary.ack.acceptedSequence);
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("saved = 1\n");
        expect(
          yield* Effect.promise(() =>
            access(marker).then(
              () => true,
              () => false
            )
          )
        ).toBe(false);

        const trust = yield* rpc.client["languages.trust.get"]({
          scope: P.LanguageTrustScope.cases.Workspace.make({
            hostId: hello.host.hostId,
            workspaceId,
          }),
        });

        expect(trust.trusted).toBe(false);
      })
    ).pipe(Effect.provide(EventStore.layerSqlite(":memory:")))
  );
}, 120000);

function verifyFeature(method: string, result: typeof P.LanguageJson.Type) {
  if (method === "textDocument/definition") expect(JSON.stringify(result)).toContain("value.py");

  if (method === "textDocument/rename") expect(JSON.stringify(result)).toContain("renamed");
}
