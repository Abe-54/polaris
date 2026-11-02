import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as P from "@polaris/protocol";
import { Effect, Layer, Predicate, Redacted } from "effect";
import { connectRpc, socketTransport } from "@polaris/client";
import { EventStore } from "../../store/EventStore.ts";
import { startServer } from "../../transport/server.ts";
import { lazyLanguageHandlers } from "../../transport/lazyLanguages.ts";
import { scopedTempDir } from "../../platform/tempDir.testing.ts";

const slice4 = "e935a0b2df579672004ee9c6bef4dfcd8374e3f7";

const repository = resolve(import.meta.dir, "../../../../..");

const caps: P.Capability[] = ["languages", "languages.trust"];

async function seedSlice4(root: string) {
  const source = join(root, "slice4");
  await mkdir(source);

  const archive = execFileSync("git", ["archive", slice4, "apps/daemon/src/languages"], {
    cwd: repository,
    maxBuffer: 32 * 1024 * 1024,
  });

  execFileSync("tar", ["-xf", "-", "-C", source], { input: archive });
  await symlink(
    join(repository, "apps/daemon/node_modules"),
    join(source, "apps/daemon/node_modules")
  );
  const languages = join(source, "apps/daemon/src/languages");
  const bootstrap = join(source, "apps/daemon/seed.mjs");
  await writeFile(join(root, "host-id"), "00000000-0000-4000-8000-000000000001\n", { mode: 0o600 });
  await writeFile(
    bootstrap,
    `
import { createInstaller } from ${JSON.stringify(join(languages, "install/index.ts"))};
import { catalog } from ${JSON.stringify(join(languages, "catalog/index.ts"))};
import { decodeUpstream, upstreamLimits } from ${JSON.stringify(join(languages, "install/upstream.ts"))};
import { httpsArtifactDownload } from ${JSON.stringify(join(languages, "install/download.ts"))};
const installer = await createInstaller({ root: ${JSON.stringify(join(root, "languages"))}, hostId: "00000000-0000-4000-8000-000000000001", platform: { os: "darwin", arch: "arm64", libc: "none" }, sizeProfile: "upstream-runtime", limits: upstreamLimits, adapters: { download: httpsArtifactDownload(fetch, upstreamLimits.downloadBytes), decode: decodeUpstream, approve: async(exact) => ({ approved: true, identity: exact.identity }), beforeSelect: async()=>{} } });
try {
for (const id of ["node", "typescript", "typescript-language-server"]) {
 const tool = catalog.tools.find(tool=>tool.id===id);
 const handle = installer.install({ tool, connected: true, probes: [{ id: "node", executable: "private-node", version: "24.18.0" }], intent: "encounter" });
 console.log("slice4 installed", id, (await handle.result).identity);
}
} finally { await installer.dispose(); }
`
  );
  const child = Bun.spawn([process.execPath, bootstrap], { stdout: "pipe", stderr: "pipe" });

  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  console.log(stdout);

  if (exit !== 0) throw new Error(`Slice 4 seed failed: ${stderr}`);
  await rm(source, { recursive: true, force: true });
}

async function prepareProject(project: string) {
  await mkdir(project);
  await writeFile(join(project, "package.json"), "{}");
  await writeFile(join(project, "a.ts"), "export const value = 42;\n");
  await writeFile(join(project, "a.py"), "value: int = 'wrong'\n");

  for (const name of ["typescript", `@typescript/typescript-${process.platform}-${process.arch}`])
    await cp(
      await realpath(
        join(
          await realpath(join(repository, "node_modules/typescript")),
          name === "typescript" ? "." : "../" + name
        )
      ),
      join(project, "node_modules", name),
      { recursive: true, dereference: true }
    );
  await mkdir(join(project, ".venv/bin"), { recursive: true });
  await cp("/usr/bin/python3", join(project, ".venv/bin/python"));
}

const ready = Effect.fn("UpgradeReady")(function* (
  client: import("@polaris/client").DaemonClient,
  input: typeof P.AcquireLanguageContext.payloadSchema.Type,
  label: string
) {
  let snapshot = yield* client["languages.context.acquire"](input);
  const uri = pathToFileURL(input.path).href;

  if (!snapshot.ack.documents.some((document) => document.uri === uri)) {
    yield* client["languages.document.sync"]({
      context: snapshot.context,
      sequence: snapshot.ack.acceptedSequence + 1,
      notification: P.LanguageDocumentNotification.cases.Open.make({
        uri,
        languageId: input.path.endsWith(".ts") ? "typescript" : "python",
        version: 1,
        text: yield* Effect.promise(() => Bun.file(input.path).text()),
      }),
    });
  }

  for (let count = 0; count < 600 && !Predicate.isTagged(snapshot.runtime, "Ready"); count++) {
    if (Predicate.isTagged(snapshot.runtime, "Failed"))
      throw new Error(JSON.stringify(snapshot.runtime));
    yield* Effect.sleep("20 millis");
    snapshot = yield* client["languages.context.acquire"](input);
  }

  expect(snapshot.runtime._tag).toBe("Ready");
  expect(snapshot.ack.documents).toEqual([{ uri, version: 1 }]);
  console.log(label, "Ready", JSON.stringify(snapshot.runtime));
  yield* client["languages.context.release"]({
    context: snapshot.context,
    interestId: "file",
  });
});

for (const legacy of ["slice4", "owner-copy"])
  test(`upgraded ${legacy} home reaches bundled TS, trusted native TS7, basedpyright and Ruff Ready`, async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* scopedTempDir("polaris-upgrade-", { short: true });

          yield* Effect.promise(() =>
            legacy === "slice4"
              ? seedSlice4(root)
              : cp(join(repository, ".dagr/evidence/upgrade-repro/dev-home"), root, {
                  recursive: true,
                })
          );
          const project = join(root, "project");
          yield* Effect.promise(() => prepareProject(project));
          const workspaceId = P.WorkspaceId.make("upgrade-fixture");
          const store = yield* EventStore;
          yield* store.commit({
            commandId: null,
            decide: () =>
              Effect.succeed([
                P.DomainEvent.cases.WorkspaceRegistered.make({
                  workspace: new P.Workspace({
                    id: workspaceId,
                    path: project,
                    name: "upgrade",
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
            clientName: "upgrade-test",
            clientVersion: "0",
            deviceLabel: "isolated",
            capabilities: caps,
            languageProof: Redacted.make("f".repeat(64)),
          });

          if (hello.languageIdentity === undefined)
            throw new Error("Missing authenticated identity");
          const checkout = P.LanguageCheckout.cases.Workspace.make({ workspaceId, path: project });

          const settings = P.LanguageEffectiveSettings.make({
            revision: 0,
            formatOnSave: false,
            formatter: P.LanguageFormatterSelection.cases.None.make({}),
            providers: [],
            origins: {},
            settings: {},
          });

          for (const selection of ["bundled", "project", "basedpyright", "ruff"]) {
            const typescript = ["bundled", "project"].includes(selection);
            const providerId = typescript ? "typescript-language-server" : selection;
            const path = join(project, typescript ? "a.ts" : "a.py");

            if (selection === "project") {
              const trust = yield* rpc.client["languages.trust.change"]({
                checkout,
                path,
                action: "trust",
                expectedRevision: 0,
              });

              expect(trust.wouldRun.native).toBe(true);
              expect(trust.wouldRun.typescriptVersion).toBe("7.0.2");
            }

            const discovered = yield* rpc.client["languages.discover"]({
              checkout,
              path,
              documentLanguageId: typescript ? "typescript" : "python",
              settings,
            });

            expect(
              discovered.providers.find((provider) => provider.providerId === providerId)?.preflight
                ._tag
            ).toBe("Eligible");
            console.log(legacy, selection, "preflight", JSON.stringify(discovered.providers));

            const input = {
              clientId: hello.languageIdentity.clientId,
              contextId: selection,
              checkout,
              path,
              providerId,
              settings,
              interestId: "file",
            };

            yield* ready(rpc.client, input, `${legacy} ${selection}`);
          }
        })
      ).pipe(Effect.provide(EventStore.layerSqlite(":memory:")))
    );
  }, 180_000);
