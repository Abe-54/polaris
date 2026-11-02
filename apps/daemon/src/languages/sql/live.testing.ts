import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as P from "@polaris/protocol";
import { Effect, Layer, Predicate, Redacted, Stream } from "effect";
import { connectRpc, socketTransport } from "@polaris/client";
import { EventStore } from "../../store/EventStore.ts";
import { startServer } from "../../transport/server.ts";
import { lazyLanguageHandlers } from "../../transport/lazyLanguages.ts";
import { scopedTempDir } from "../../platform/tempDir.testing.ts";

test("real managed SQL and Shell through authenticated RPC, dialect CAS and draft-preserving replacement", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* scopedTempDir("polaris-sql-shell-live-", { short: true });

        const project = join(root, "project");
        yield* Effect.promise(async () => {
          await mkdir(project);
          await writeFile(join(project, "package.json"), "{}");
        });
        const workspaceId = P.WorkspaceId.make("fixture");
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

        const caps: P.Capability[] = [
          "languages",
          "languages.trust",
          "languages.format",
          "languages.buffer-acknowledgments",
        ];

        const server = yield* startServer({
          root,
          socketPath: join(root, "d.sock"),
          lockPath: join(root, "d.lock"),
          capabilities: caps,
          handlers: lazyLanguageHandlers.pipe(Layer.provide(Layer.succeed(EventStore)(store))),
        });

        const rpc = yield* connectRpc(yield* socketTransport(server.socketPath));
        const client = rpc.client;

        const hello = yield* client.hello({
          clientName: "sql-shell-proof",
          clientVersion: "0",
          deviceLabel: "isolated",
          capabilities: caps,
          languageProof: Redacted.make("f".repeat(64)),
        });

        if (hello.languageIdentity === undefined)
          throw new Error("Authenticated identity unavailable");
        const checkout = P.LanguageCheckout.cases.Workspace.make({ workspaceId, path: project });

        for (const dialect of ["postgresql", "mysql", "sqlite", "generic", "shell"] as const) {
          yield* verifyLanguage(
            client,
            hello.languageIdentity.clientId,
            checkout,
            project,
            dialect
          );
        }

        const catalog = yield* client["languages.catalog"]({});
        expect(
          catalog.integrations.filter((item) => item.offered).map((item) => item.id)
        ).toContain("sql");
        expect(
          catalog.integrations.filter((item) => item.offered).map((item) => item.id)
        ).toContain("bash");
      })
    ).pipe(Effect.provide(EventStore.layerSqlite(":memory:")))
  );
}, 240000);

type Client = import("@polaris/client").DaemonClient;

type Dialect = P.LanguageSqlDialect | "shell";

const verifyLanguage = Effect.fn("verifyLanguage")(function* (
  client: Client,
  clientId: string,
  checkout: P.LanguageCheckout,
  project: string,
  dialect: Dialect
) {
  const shell = dialect === "shell";
  const providerId = shell ? "bash-language-server" : "sqllens-language-server";
  const file = join(project, shell ? "script.sh" : dialect + ".sql");
  yield* Effect.promise(() =>
    writeFile(
      file,
      shell ? "#!/bin/bash\necho $value\n" : `-- polaris-sql-dialect: ${dialect}\nSELECT * FROM ;\n`
    )
  );

  const settings = P.LanguageEffectiveSettings.make({
    revision: 0,
    formatOnSave: true,
    formatter: P.LanguageFormatterSelection.cases.Provider.make({ providerId }),
    providers: [],
    origins: {},
    settings: fixtureSettings(shell),
  });

  const discovery = yield* client["languages.discover"]({
    checkout,
    path: file,
    documentLanguageId: shell ? "shellscript" : "sql",
    settings,
  });

  expect(discovery.providers.every((item) => Predicate.isTagged(item.preflight, "Eligible"))).toBe(
    true
  );

  const input = {
    clientId,
    contextId: dialect,
    checkout,
    path: file,
    providerId,
    settings,
    interestId: "file",
  };

  let snapshot = yield* client["languages.context.acquire"](input);
  const uri = pathToFileURL(file).href;
  const text = shell ? "#!/bin/bash\necho $value\n" : "SELECT * FROM ;";
  yield* client["languages.document.sync"]({
    context: snapshot.context,
    sequence: 1,
    notification: P.LanguageDocumentNotification.cases.Open.make({
      uri,
      languageId: shell ? "shellscript" : "sql",
      version: 1,
      text,
    }),
  });

  for (let i = 0; i < 1000 && !Predicate.isTagged(snapshot.runtime, "Ready"); i++) {
    yield* Effect.sleep("20 millis");
    snapshot = yield* client["languages.context.acquire"](input);

    if (Predicate.isTagged(snapshot.runtime, "Failed")) throw new Error(snapshot.runtime.message);
  }

  expect(Predicate.isTagged(snapshot.runtime, "Ready")).toBe(true);
  console.log("ready", dialect, snapshot.context);

  let fence = {
    context: snapshot.context,
    requiredSequence: snapshot.ack.acceptedSequence,
    documents: [{ uri, version: 1 }],
  };

  if (dialect === "generic" && Predicate.isTagged(snapshot.runtime, "Ready")) {
    expect(snapshot.runtime.capabilities.methods).not.toContain("textDocument/completion");
    expect(snapshot.runtime.capabilities.methods).not.toContain("textDocument/diagnostic");
  } else yield* verifyFeatures(client, snapshot.context, fence, uri, dialect);

  const formattedText = shell ? "#!/bin/bash\nif true;then echo hi;fi\n" : "select 1,2;";

  const ack = yield* client["languages.document.sync"]({
    context: snapshot.context,
    sequence: 2,
    notification: P.LanguageDocumentNotification.cases.Change.make({
      uri,
      previousVersion: 1,
      version: 2,
      changes: [{ text: formattedText }],
    }),
  });

  fence = {
    context: snapshot.context,
    requiredSequence: ack.acceptedSequence,
    documents: [{ uri, version: 2 }],
  };

  const formatted = yield* client["languages.format"]({
    requestId: "format",
    fence,
    document: { uri, version: 2 },
    snapshot: formattedText,
    expectedDiskVersion: P.FileVersion.make({ mtimeMs: 0, size: 0, hash: "a".repeat(64) }),
    reason: "manual",
    formatter: settings.formatter,
    options: { tabSize: 2, insertSpaces: true },
    deadline: Date.now() + 15000,
  });

  expect(Predicate.isTagged(formatted, "Formatted")).toBe(true);
  console.log("formatted", dialect, JSON.stringify(formatted));

  if (Predicate.isTagged(formatted, "Formatted"))
    expect(formatted.edits[0]?.newText).not.toBe(formattedText);

  if (dialect === "postgresql") {
    const prior = yield* client["languages.sql.dialect.get"]({ checkout, path: file });

    const selected = yield* client["languages.sql.dialect.select"]({
      checkout,
      path: file,
      scope: "file",
      dialect: "sqlite",
      expectedRevision: prior.revision,
    });

    expect(selected.dialect).toBe("sqlite");
    snapshot = yield* client["languages.context.acquire"](input);
    expect(snapshot.ack.documents).toEqual([{ uri, version: 2 }]);
    expect(snapshot.context.generation).toBeGreaterThan(fence.context.generation);
  }

  yield* client["languages.context.release"]({
    context: snapshot.context,
    interestId: "file",
  });
});

const verifyFeatures = Effect.fn("verifyFeatures")(function* (
  client: Client,
  context: P.LanguageContextIdentity,
  fence: P.LanguageRequestFence,
  uri: string,
  dialect: Dialect
) {
  if (dialect === "shell") {
    const warnings = yield* client["languages.context.watch"]({
      context: context,
    }).pipe(
      Stream.filter(
        (event) =>
          Predicate.isTagged(event, "Diagnostics") && JSON.stringify(event).includes("2086")
      ),
      Stream.take(1),
      Stream.runCollect,
      Effect.timeout(15000)
    );

    expect(warnings.length).toBe(1);
    console.log("shellcheck", JSON.stringify(warnings));
  } else {
    const diagnostics = yield* client["languages.request"]({
      requestId: "diagnostics",
      fence,
      method: "textDocument/diagnostic",
      params: { textDocument: { uri } },
      deadline: Date.now() + 15000,
    });

    const completion = yield* client["languages.request"]({
      requestId: "completion",
      fence,
      method: "textDocument/completion",
      params: { textDocument: { uri }, position: { line: 0, character: 3 } },
      deadline: Date.now() + 15000,
    });

    console.log(
      "sql-features",
      dialect,
      JSON.stringify(diagnostics.result),
      JSON.stringify(completion.result)
    );
    expect(JSON.stringify(diagnostics.result).includes('"severity":1')).toBe(true);
    expect(JSON.stringify(completion.result).includes("SELECT")).toBe(true);
  }
});

const fixtureSettings = (shell: boolean): P.LanguageSettingsPatch =>
  shell
    ? {
        serverSettings: {
          "bash-language-server": {
            bashIde: {
              shellcheckPath: "/unapproved/shellcheck",
              shfmt: { path: "/unapproved/shfmt" },
              backgroundAnalysisMaxFiles: 999,
              explainshellEndpoint: "https://example.invalid",
            },
          },
        },
      }
    : {};
