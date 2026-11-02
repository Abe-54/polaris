import { expect, test } from "bun:test";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as P from "@polaris/protocol";
import { Effect, Fiber, Layer, Option, Schema, Predicate, Redacted, Result, Stream } from "effect";
import { connectRpc, socketTransport } from "@polaris/client";
import { EventStore } from "../../store/EventStore.ts";
import { startServer } from "../../transport/server.ts";
import { lazyLanguageHandlers } from "../../transport/lazyLanguages.ts";
import { scopedTempDir } from "../../platform/tempDir.testing.ts";

/**
 * Opt-in: run with HOME set to POLARIS_LIVE_HOME, a Host home holding `.local/bin/php` (Bun reads
 * HOME once). POLARIS_LIVE_GOPLS is a built gopls, copied into `go/bin` mid-test.
 */
const home = process.env.POLARIS_LIVE_HOME === homedir() ? homedir() : "";

const goplsBuild = process.env.POLARIS_LIVE_GOPLS ?? "";

const fixer = process.env.POLARIS_LIVE_PHP_CS_FIXER ?? "";

type Client = import("@polaris/client").DaemonClient;

const settingsFor = (providerId: string) =>
  P.LanguageEffectiveSettings.make({
    revision: 0,
    formatOnSave: true,
    formatter: P.LanguageFormatterSelection.cases.Provider.make({ providerId }),
    providers: [],
    origins: {},
    settings: {},
  });

const php = {
  "composer.json": '{"autoload":{"psr-4":{"App\\\\":"src/"}}}\n',
  "src/Greeter.php":
    "<?php\n\nnamespace App;\n\nclass Greeter\n{\n    /** Says hello. */\n    public function greet(string $name): string\n    {\n        return 'Hello ' . $name;\n    }\n}\n",
  "src/main.php":
    "<?php\n\nnamespace App;\n\n$greeter = new Greeter();\necho $greeter->greet('x');\n$greeter->missing();\n",
};

const go = {
  "go.mod": "module example.com/fixture\n\ngo 1.22\n",
  "greet.go":
    'package main\n\n// Greet says hello.\nfunc Greet(name string) string { return "Hello " + name }\n',
  "main.go":
    'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println(Greet("x"))\n\tvar unused int = "no"\n}\n',
};

const write = async (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
};

test.skipIf(home === "" || goplsBuild === "" || fixer === "")(
  "real Phpactor and gopls: Prerequisites, Check again, the Trust split and every feature",
  async () => {
    await rm(join(home, "go/bin/gopls"), { force: true });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* scopedTempDir("polaris-go-php-live-", { short: true });

          const project = join(root, "project");
          const sentinel = join(root, "project-code-ran");
          yield* Effect.promise(async () => {
            await write(join(project, "php"), php);
            await write(join(project, "go"), go);
            const run = `<?php file_put_contents(${JSON.stringify(sentinel)}, __FILE__); return [];\n`;
            await write(join(project, "php"), {
              "vendor/autoload.php": run,
              "vendor/composer/autoload_psr4.php": run,
              "vendor/composer/autoload_classmap.php": run,
              ".phpactor.json": '{"composer.enable": true}\n',
            });
            await mkdir(join(project, "php/vendor/bin"));
            await copyFile(fixer, join(project, "php/vendor/bin/php-cs-fixer"));
            await chmod(join(project, "php/vendor/bin/php-cs-fixer"), 0o755);
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

          const { client } = yield* connectRpc(yield* socketTransport(server.socketPath));

          const hello = yield* client.hello({
            clientName: "go-php-proof",
            clientVersion: "0",
            deviceLabel: "isolated",
            capabilities: caps,
            languageProof: Redacted.make("f".repeat(64)),
          });

          if (hello.languageIdentity === undefined) throw new Error("No language identity");
          const clientId = hello.languageIdentity.clientId;
          const checkout = P.LanguageCheckout.cases.Workspace.make({ workspaceId, path: project });

          const discover = (path: string, languageId: string, providerId: string, refresh = true) =>
            client["languages.discover"]({
              checkout,
              path,
              documentLanguageId: languageId,
              settings: settingsFor(providerId),
              refresh,
            });

          // PHP before Trust: managed, running, with no project code.
          const main = join(project, "php/src/main.php");
          const phpDiscovery = yield* discover(main, "php", "phpactor");
          console.log("php-untrusted", JSON.stringify(phpDiscovery.providers));
          expect(phpDiscovery.trustRequest?.wouldRun.workspaceTools).toEqual([
            "a Phpactor config",
            "a Composer autoloader",
            "php-cs-fixer",
          ]);

          const untrusted = yield* features(
            client,
            clientId,
            checkout,
            main,
            "php",
            "phpactor",
            "u"
          );

          expect(untrusted.formatted).toBe(false);
          expect(yield* Effect.promise(() => Bun.file(sentinel).exists())).toBe(false);

          // Go: gopls missing, then Check again finds it; Trust is still needed.
          const mainGo = join(project, "go/main.go");
          const missing = yield* discover(mainGo, "go", "gopls");
          console.log("go-missing", JSON.stringify(missing.providers));
          expect(missing.providers[0]?.preflight).toMatchObject({ reason: "missing-prerequisite" });

          const goplsFact = missing.providers[0]?.prerequisites.find(
            (item) => item.requirement.id === "gopls"
          );

          expect(goplsFact?.outcome).toBe("missing");
          expect(goplsFact?.requirement.installCommands?.[0]?.command).toBe(
            "go install golang.org/x/tools/gopls@latest"
          );

          yield* Effect.promise(async () => {
            await mkdir(join(home, "go/bin"), { recursive: true });
            await copyFile(goplsBuild, join(home, "go/bin/gopls"));
            await chmod(join(home, "go/bin/gopls"), 0o755);
          });

          const found = yield* discover(mainGo, "go", "gopls");
          expect(found.providers[0]?.preflight).toMatchObject({ reason: "awaiting-trust" });

          const granted = yield* client["languages.trust.change"]({
            checkout,
            path: mainGo,
            action: "trust",
            expectedRevision: found.trust.revision,
          });

          expect(granted.trust.trusted).toBe(true);

          const eligible = yield* discover(mainGo, "go", "gopls", false);
          expect(Predicate.isTagged(eligible.providers[0]?.preflight, "Eligible")).toBe(true);
          const goResult = yield* features(client, clientId, checkout, mainGo, "go", "gopls", "g");
          expect(goResult.formatted).toBe(true);

          // PHP after Trust: project config, Composer and php-cs-fixer.
          const trusted = yield* features(client, clientId, checkout, main, "php", "phpactor", "t");
          expect(trusted.formatted).toBe(true);
          // After Trust, Phpactor loads the project's Composer class maps.
          expect(yield* Effect.promise(() => Bun.file(sentinel).exists())).toBe(true);
        })
      ).pipe(Effect.provide(EventStore.layerSqlite(":memory:")))
    );
  },
  600000
);

/** Where each fixture is probed, and what the answers must contain. */
const GO_MARKS = {
  symbol: "Greet(",
  completion: "Println",
  offset: 3,
  target: "greet.go",
  completed: "Println",
  messy: "package main\nfunc  main( ) {   }\n",
};

const PHP_MARKS = {
  symbol: "greet(",
  completion: "greet(",
  offset: 2,
  target: "Greeter.php",
  completed: "greet",
  messy: "<?php\nfunction  f( ){return 1;}\n",
};

interface Positioned {
  readonly position: { readonly line: number; readonly character: number };
}

const CompletionList = Schema.Struct({ items: Schema.Array(Schema.JsonObject) });

const untilReady = Effect.fn("untilReady")(function* (
  client: Client,
  input: Parameters<Client["languages.context.acquire"]>[0],
  first: typeof P.LanguageContextSnapshot.Type
) {
  let snapshot = first;

  for (let i = 0; i < 3000 && !Predicate.isTagged(snapshot.runtime, "Ready"); i++) {
    yield* Effect.sleep("20 millis");
    snapshot = yield* client["languages.context.acquire"](input);

    if (
      Predicate.isTagged(snapshot.runtime, "Failed") ||
      Predicate.isTagged(snapshot.runtime, "Stopped")
    )
      throw new Error(JSON.stringify(snapshot.runtime));
  }

  return snapshot;
});

const untilHover = Effect.fn("untilHover")(function* <E, R>(
  ask: () => Effect.Effect<P.LanguageFeatureResult, E, R>
) {
  let hover = yield* ask();

  for (
    let i = 0;
    i < 60 && !JSON.stringify(hover.result).toLowerCase().includes("says hello");
    i++
  ) {
    yield* Effect.sleep("2 seconds");
    hover = yield* ask();
  }

  return hover;
});

const features = Effect.fn("features")(function* (
  client: Client,
  clientId: string,
  checkout: P.LanguageCheckout,
  file: string,
  languageId: string,
  providerId: string,
  contextId: string
) {
  const settings = settingsFor(providerId);
  const mark = languageId === "go" ? GO_MARKS : PHP_MARKS;

  const input = {
    clientId,
    contextId,
    checkout,
    path: file,
    providerId,
    settings,
    interestId: "f",
  };

  let snapshot = yield* client["languages.context.acquire"](input);
  const uri = pathToFileURL(file).href;
  const text = yield* Effect.promise(() => readFile(file, "utf8"));

  let sequence = snapshot.ack.acceptedSequence + 1;
  yield* client["languages.document.sync"]({
    context: snapshot.context,
    sequence,
    notification: P.LanguageDocumentNotification.cases.Open.make({
      uri,
      languageId,
      version: 1,
      text,
    }),
  });

  snapshot = yield* untilReady(client, input, snapshot);
  expect(Predicate.isTagged(snapshot.runtime, "Ready")).toBe(true);

  const capabilities = Predicate.isTagged(snapshot.runtime, "Ready")
    ? snapshot.runtime.capabilities.methods
    : [];

  console.log(contextId, "capabilities", JSON.stringify(capabilities));

  let version = 1;
  let ack = snapshot.ack;

  const change = (next: string) =>
    Effect.gen(function* () {
      ack = yield* client["languages.document.sync"]({
        context: snapshot.context,
        sequence: ++sequence,
        notification: P.LanguageDocumentNotification.cases.Change.make({
          uri,
          previousVersion: version,
          version: version + 1,
          changes: [{ text: next }],
        }),
      });
      version++;
    });

  const published = (wait: number) =>
    client["languages.context.watch"]({ context: snapshot.context }).pipe(
      Stream.filter(
        (event) =>
          Predicate.isTagged(event, "Diagnostics") &&
          event.diagnostics.uri === uri &&
          event.diagnostics.items.length > 0
      ),
      Stream.take(1),
      Stream.runCollect,
      Effect.timeoutOption(wait)
    );

  const fence = () => ({
    context: snapshot.context,
    requiredSequence: ack.acceptedSequence,
    documents: [{ uri, version }],
  });

  let requests = 0;

  const lines = text.split("\n");

  const at = (needle: string, offset = 1) => {
    const line = lines.findIndex((item) => item.includes(needle));

    return { line, character: lines[line]!.indexOf(needle) + offset };
  };

  const request = (method: typeof P.LanguageFeatureMethod.Type, params: Positioned) =>
    client["languages.request"]({
      requestId: `${contextId}-${++requests}`,
      fence: fence(),
      method,
      params: { textDocument: { uri }, ...params },
      deadline: Date.now() + 30000,
    });

  // The first answers can come before the server has indexed the Workspace.
  const hover = yield* untilHover(() =>
    request("textDocument/hover", { position: at(mark.symbol) })
  );

  // Phpactor rechecks open files on edits, not when its first index finishes.
  let diagnostics = yield* published(5000);

  for (let i = 0; i < 20 && Option.isNone(diagnostics); i++) {
    const watching = yield* Effect.forkChild(published(5000));
    yield* change(text);
    diagnostics = yield* Fiber.join(watching);
  }

  const definition = yield* request("textDocument/definition", {
    position: at(mark.symbol),
  });

  const completion = yield* request("textDocument/completion", {
    position: at(mark.completion, mark.offset),
  });

  console.log(contextId, "hover", JSON.stringify(hover.result));
  console.log(contextId, "definition", JSON.stringify(definition.result));
  console.log(contextId, "completion", JSON.stringify(completion.result).slice(0, 4000));

  const first = Option.flatMap(
    Schema.decodeUnknownOption(CompletionList)(completion.result),
    (list) => Option.fromNullishOr(list.items[0])
  );

  if (capabilities.includes("completionItem/resolve") && Option.isSome(first)) {
    const resolved = yield* client["languages.request"]({
      requestId: `${contextId}-${++requests}`,
      fence: fence(),
      method: "completionItem/resolve",
      params: first.value,
      deadline: Date.now() + 30000,
    });

    console.log(contextId, "resolved", JSON.stringify(resolved.result));
  }

  expect(Option.isSome(diagnostics)).toBe(true);
  expect(JSON.stringify(hover.result).toLowerCase()).toContain("says hello");
  expect(JSON.stringify(definition.result)).toContain(mark.target);
  expect(JSON.stringify(completion.result)).toContain(mark.completed);

  const messy = mark.messy;

  yield* change(messy);

  const formatted = yield* client["languages.format"]({
    requestId: `${contextId}-format`,
    fence: {
      context: snapshot.context,
      requiredSequence: ack.acceptedSequence,
      documents: [{ uri, version }],
    },
    document: { uri, version },
    snapshot: messy,
    expectedDiskVersion: P.FileVersion.make({ mtimeMs: 0, size: 0, hash: "a".repeat(64) }),
    reason: "manual",
    formatter: settings.formatter,
    options: { tabSize: 4, insertSpaces: languageId !== "go" },
    deadline: Date.now() + 30000,
  }).pipe(Effect.result);

  console.log(contextId, "format", JSON.stringify(formatted));

  yield* client["languages.document.sync"]({
    context: snapshot.context,
    sequence: ++sequence,
    notification: P.LanguageDocumentNotification.cases.Close.make({ uri, version }),
  });
  yield* client["languages.context.release"]({ context: snapshot.context, interestId: "f" });

  return {
    formatted:
      Result.isSuccess(formatted) &&
      Predicate.isTagged(formatted.success, "Formatted") &&
      formatted.success.edits.length > 0,
  };
});
