import { expect, test } from "bun:test";
import { symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { Effect, Stream } from "effect";
import { Terminals, TerminalsLive, TerminalItem } from "../../terminal/Terminals.ts";
import { TraceRuntime } from "../runtime.ts";
import { TraceSettings } from "../settings.ts";
import { TraceStore } from "../store.ts";
import { TEST_SESSION, TEST_WORKSPACE, postTraces } from "../testing.ts";
import { withInstrumentation } from "./integration.testing.ts";

// ENG-703: the app's SDK preloaded the usual way; getNodeAutoInstrumentations registers this HttpInstrumentation.
const appInstrumentation = `
import { NodeSDK } from "@opentelemetry/sdk-node";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
let appSpans = 0;
const traceExporter = { export: (spans, done) => { appSpans += spans.length; done({ code: 0 }); }, shutdown: async () => {} };
const sdk = new NodeSDK({ serviceName: "app", traceExporter, instrumentations: [new HttpInstrumentation()] });
sdk.start();
globalThis.appDone = async () => { await sdk.shutdown(); console.log("app-spans=" + appSpans); };
`;

const appServer = `
const http = require("node:http");
const server = http.createServer((_req, res) => res.end("ok"));
server.listen(0, "127.0.0.1", () => {
  http.get("http://127.0.0.1:" + server.address().port + "/", (res) => {
    res.resume();
    res.on("end", () => { server.close(); globalThis.appDone(); });
  });
});
`;

test(
  "an override that the app's own instrumentations silence reports why Traces is empty",
  () =>
    withInstrumentation(async (f) => {
      await writeFile(
        join(f.checkout, "package.json"),
        '{"name":"owned","dependencies":{"@opentelemetry/sdk-node":"0.300.0"}}'
      );
      await writeFile(join(f.checkout, "package/app.cjs"), appServer);
      await writeFile(join(f.checkout, "package/instrumentation.mjs"), appInstrumentation);
      await symlink(
        join(
          dirname(createRequire(import.meta.url).resolve("../../../package.json")),
          "node_modules"
        ),
        join(f.checkout, "node_modules")
      );
      await f.runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const settings = yield* TraceSettings;
            yield* settings.patch(TEST_WORKSPACE, {
              autoInstrument: "node",
              autoInstrumentOverride: true,
              forwarding: false,
            });
            const terminals = yield* Terminals;

            const terminal = yield* terminals.open({
              cwd: join(f.checkout, "package"),
              argv: ["node", "--import", "./instrumentation.mjs", "app.cjs"],
              rows: 24,
              cols: 80,
              environment: "repository",
            });

            const output = yield* terminals.attach(terminal).pipe(Stream.runCollect);
            expect(output.find(TerminalItem.guards.Exit)?.code).toBe(0);

            const printed = output
              .filter(TerminalItem.guards.Output)
              .map((item) => new TextDecoder().decode(item.data))
              .join("");

            expect(Number(/app-spans=(\d+)/.exec(printed)?.[1])).toBeGreaterThan(0);
            yield* terminals.close(terminal);

            // The app's HttpInstrumentation unwrapped Polaris's, so Polaris has no spans.
            expect((yield* (yield* TraceStore).list(f.checkout)).total).toBe(0);
            expect((yield* settings.get(TEST_WORKSPACE)).autoInstrumentSkipReason).toBe(
              "No spans arrived with the override on: instrumentations loaded by the app's @opentelemetry/sdk-node (such as getNodeAutoInstrumentations) replace Polaris's."
            );

            const env = yield* (yield* TraceRuntime).environment(TEST_SESSION, {});
            yield* Effect.promise(() => postTraces(env.OTEL_EXPORTER_OTLP_ENDPOINT!));
            expect((yield* settings.get(TEST_WORKSPACE)).autoInstrumentSkipReason).toBeNull();
          }).pipe(Effect.provide(TerminalsLive))
        )
      );
    }),
  20000
);
