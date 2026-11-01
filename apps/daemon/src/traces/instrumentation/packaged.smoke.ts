import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect, Option, Stream, Predicate } from "effect";
import { HostId, SessionId, TraceAvailability } from "@polaris/protocol";
import { awaitReady, connect, launchDaemon } from "../../../../../packages/bench/src/daemon.ts";
import { registerWorkspace, startSession } from "../../../../../packages/bench/src/drive.ts";
import { changeTrust } from "../../constellation/setup/trust.testing.ts";
import { executableOf } from "../../platform/executable.ts";
import { EventStore } from "../../store/EventStore.ts";

/** Disposable built-binary smoke; the only Trust record belongs to its new scratch Workspace. */
export const packagedInstrumentationSmoke = async (binary: string) => {
  if (process.env.POLARIS_LEASE_HELD !== "bench")
    throw new Error("Run this smoke under lease bench");
  const root = await mkdtemp("/tmp/p3-packaged-");
  const checkout = join(root, "app");
  const home = join(root, "home");
  await mkdir(checkout);
  await writeFile(join(checkout, "package.json"), '{"name":"packaged-node-app"}');
  const script = join(checkout, "app.mjs");
  await writeFile(
    script,
    `import http from 'node:http';
    import {writeFile} from 'node:fs/promises'; import {fileURLToPath} from 'node:url';
    const imported = JSON.parse(process.env.NODE_OPTIONS.match(/--import ("[^"\\n]+")/)[1]);
    await writeFile('register-path.txt', fileURLToPath(imported));
    const server=http.createServer((_req,res)=>res.end('packaged-ok'));
    server.listen(0,'127.0.0.1',async()=>{
      console.log(await (await fetch('http://127.0.0.1:'+server.address().port+'/packaged')).text());
      server.close();
    });`
  );
  const packaged = join(root, "polaris");
  await copyFile(binary, packaged);
  await chmod(packaged, 0o755);

  const previousDirectory = process.cwd();

  const daemon = await (async () => {
    process.chdir(root);

    try {
      return await launchDaemon({
        binary: packaged,
        home,
        env: {
          POLARIS_HOST_SOCKET: join(home, "daemon.sock"),
          NODE_OPTIONS: "",
          BUN_OPTIONS: "",
          OTEL_EXPORTER_OTLP_ENDPOINT: "",
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
          OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "",
          OTEL_EXPORTER_OTLP_HEADERS: "",
          OTEL_EXPORTER_OTLP_TRACES_HEADERS: "",
          OTEL_EXPORTER_OTLP_LOGS_HEADERS: "",
        },
      });
    } finally {
      process.chdir(previousDirectory);
    }
  })();

  try {
    await Effect.runPromise(awaitReady(daemon));

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* connect(daemon, "socket", "P3 packaged smoke");
          const rpc = client.connection.client;
          const workspaceId = yield* registerWorkspace(client, checkout, "P3 packaged smoke");

          const hostId = HostId.make(
            (yield* Effect.promise(() => readFile(join(home, "host-id"), "utf8"))).trim()
          );

          yield* changeTrust(home, hostId, workspaceId, "trust").pipe(
            Effect.provide(EventStore.layerSqlite(join(home, "state.sqlite")))
          );
          yield* rpc["traces.setSettings"]({
            workspaceId,
            settings: { autoInstrument: "node", forwarding: false },
          });
          const sessionId = SessionId.make("p3-packaged");
          yield* startSession(client, { sessionId, workspaceId, script: { items: 0 } });
          const setup = yield* rpc["traces.watch"]({ sessionId, filter: {} }).pipe(Stream.runHead);

          if (Option.isNone(setup) || !TraceAvailability.guards.Listening(setup.value.availability))
            throw new Error("Built Daemon's fixed receiver port is unavailable");

          const { terminalId } = yield* rpc["terminal.open"]({
            cwd: checkout,
            argv: ["node", script],
            cols: 80,
            rows: 24,
          });

          const output = yield* rpc["terminal.attach"]({ terminalId }).pipe(Stream.runCollect);

          const text = output
            .filter((item) => Predicate.isTagged(item, "Output"))
            .map((item) => new TextDecoder().decode(item.data))
            .join("");

          const exit = output.find((item) => Predicate.isTagged(item, "Exit"));

          if (!text.includes("packaged-ok") || exit?.code !== 0)
            throw new Error(`Built Daemon's Node child failed: ${text}`);
          yield* rpc["terminal.close"]({ terminalId });
          const page = yield* rpc["traces.watch"]({ sessionId, filter: {} }).pipe(Stream.runHead);

          if (Option.isNone(page) || page.value.traces.length === 0)
            throw new Error("No packaged app spans stored");
          const detail = yield* rpc["traces.get"]({ sessionId, traceId: page.value.traces[0]!.id });

          if (
            !detail.spans.some((span) => span.kind === "server") ||
            !detail.spans.some(
              (span) => span.scope.name === "@opentelemetry/instrumentation-undici"
            ) ||
            !detail.spans.every((span) => span.resource["service.name"] === "packaged-node-app")
          )
            throw new Error(
              "Packaged instrumentation did not preserve HTTP/fetch and service attribution"
            );

          return { spans: detail.spans.length, service: detail.spans[0]!.resource["service.name"] };
        })
      )
    );

    const register = await readFile(join(checkout, "register-path.txt"), "utf8");

    if (!register.startsWith(join(home, "node-instrumentation")))
      throw new Error("Preload was not extracted from the built binary");
    console.log(
      JSON.stringify({
        ...result,
        extractedFromBinary: true,
        node: Bun.spawnSync([executableOf("node"), "--version"])
          .stdout.toString()
          .trim(),
      })
    );
  } finally {
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const binary = process.argv[2];

  if (binary === undefined) throw new Error("Pass the built polaris binary path");
  await packagedInstrumentationSmoke(resolve(binary));
}
