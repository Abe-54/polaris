import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Effect, Stream } from "effect";
import { DomainEvent, TurnItem, DetectedTraceExporter } from "@polaris/protocol";
import { Terminals, TerminalsLive, TerminalItem } from "../../terminal/Terminals.ts";
import { gitText } from "../../git/git.ts";
import { TraceRuntime } from "../runtime.ts";
import { TraceSettings } from "../settings.ts";
import { TraceStore } from "../store.ts";
import { commit, turn } from "../authority.testing.ts";
import { TEST_SESSION, TEST_WORKSPACE, postTraces } from "../testing.ts";
import { withInstrumentation } from "./integration.testing.ts";

test(
  "an opted-in real terminal Node child exports HTTP/fetch spans through runtime injection",
  () =>
    withInstrumentation(async (f) => {
      await writeFile(join(f.checkout, "package.json"), '{"name":"terminal-node-app"}');
      const script = join(f.checkout, "package/app.mjs");
      await writeFile(
        script,
        `import http from 'node:http';
      const server = http.createServer((_req,res) => res.end('runtime-ok'));
      server.listen(0,'127.0.0.1', async () => {
        console.log(await (await fetch('http://127.0.0.1:'+server.address().port+'/launch')).text());
        server.close();
      });`
      );
      await f.runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const settings = yield* TraceSettings;
            yield* settings.patch(TEST_WORKSPACE, { autoInstrument: "node", forwarding: false });
            const terminals = yield* Terminals;

            const terminal = yield* terminals.open({
              cwd: join(f.checkout, "package"),
              argv: ["node", script],
              rows: 24,
              cols: 80,
              environment: "repository",
            });

            const output = yield* terminals.attach(terminal).pipe(Stream.runCollect);
            expect(
              output
                .filter(TerminalItem.guards.Output)
                .map((item) => new TextDecoder().decode(item.data))
                .join("")
            ).toContain("runtime-ok");
            expect(output.find(TerminalItem.guards.Exit)?.code).toBe(0);
            const store = yield* TraceStore;
            const page = yield* store.list(f.checkout);
            expect(page.total).toBeGreaterThan(0);

            const spans = (yield* store.get(f.checkout, page.traces[0]!.id)).spans;
            expect(spans.some((span) => span.kind === "server")).toBe(true);
            expect(
              spans.some((span) => span.scope.name === "@opentelemetry/instrumentation-undici")
            ).toBe(true);
            expect(
              spans.every((span) => span.resource["service.name"] === "terminal-node-app")
            ).toBe(true);
            expect((yield* settings.get(TEST_WORKSPACE)).autoInstrumentSkipReason).toBeNull();
            yield* terminals.close(terminal);
          }).pipe(Effect.provide(TerminalsLive))
        )
      );
    }),
  20000
);

test(
  "runtime reports SDK skip and Trust refusal, preserves child attribution and composes Deno",
  () =>
    withInstrumentation(async (f) => {
      await writeFile(
        join(f.checkout, "package.json"),
        '{"dependencies":{"@opentelemetry/sdk-node":"0.300.0"}}'
      );
      await f.runtime.runPromise(
        Effect.gen(function* () {
          const settings = yield* TraceSettings;
          const runtime = yield* TraceRuntime;
          yield* settings.patch(TEST_WORKSPACE, { autoInstrument: "node" });
          expect(yield* runtime.environment(TEST_SESSION, {})).not.toHaveProperty("NODE_OPTIONS");
          expect((yield* settings.get(TEST_WORKSPACE)).autoInstrumentSkipReason).toContain(
            "sdk-node"
          );
          yield* settings.patch(TEST_WORKSPACE, { autoInstrumentOverride: true });
          f.trust(false);
          expect(yield* runtime.environment(TEST_SESSION, {})).not.toHaveProperty("NODE_OPTIONS");
          expect((yield* settings.get(TEST_WORKSPACE)).autoInstrumentSkipReason).toContain("Trust");
          f.trust(true);
          const launched = turn(0);
          yield* commit([DomainEvent.cases.TurnStarted.make({ turn: launched })]);

          const env = yield* runtime.environment(
            TEST_SESSION,
            { NODE_OPTIONS: '--no-warnings --import "/tmp/inspector.mjs"' },
            launched.id
          );

          expect(env.NODE_OPTIONS).toMatch(
            /^--no-warnings --import "\/tmp\/inspector.mjs" --import "data:/
          );
          expect(env.POLARIS_OTEL_ENDPOINT).toBe(env.OTEL_EXPORTER_OTLP_ENDPOINT);
          const token = env.OTEL_EXPORTER_OTLP_ENDPOINT!.split("/").at(-1)!;
          expect((yield* runtime.authenticate(token))?.launchedTurn?.id).toBe(launched.id);
          yield* settings.patch(TEST_WORKSPACE, { autoInstrument: "deno" });
          expect(yield* runtime.environment(TEST_SESSION, {})).toHaveProperty("OTEL_DENO", "true");
          expect(yield* runtime.environment(TEST_SESSION, {})).not.toHaveProperty("BUN_OPTIONS");
        })
      );
    }),
  20000
);

test(
  "a real Bun child remains without a provider under a Node-only Workspace opt-in",
  () =>
    withInstrumentation(async (f) => {
      const api = createRequire(import.meta.url).resolve("@opentelemetry/api");
      const script = join(f.checkout, "bun.mjs");
      await writeFile(
        script,
        `import api from ${JSON.stringify(api)};
      const span=api.trace.getTracer('bun-probe').startSpan('probe');
      const recording=span.isRecording(); span.end();
      if(recording) throw new Error('Bun was auto-instrumented'); console.log('bun-only');`
      );
      await f.runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* (yield* TraceSettings).patch(TEST_WORKSPACE, { autoInstrument: "node" });
            const terminals = yield* Terminals;

            const terminal = yield* terminals.open({
              cwd: f.checkout,
              argv: [process.execPath, script],
              rows: 24,
              cols: 80,
            });

            const output = yield* terminals.attach(terminal).pipe(Stream.runCollect);
            expect(output.find(TerminalItem.guards.Exit)?.code).toBe(0);
            expect(
              output
                .filter(TerminalItem.guards.Output)
                .map((item) => new TextDecoder().decode(item.data))
                .join("")
            ).toContain("bun-only");
            yield* terminals.close(terminal);
          }).pipe(Effect.provide(TerminalsLive))
        )
      );
    }),
  20000
);

test("fixed-exporter settings require actual application evidence, honor ignores and clear after spans", () =>
  withInstrumentation(async (f) => {
    await gitText(f.checkout, ["init", "--quiet"]);
    await writeFile(
      join(f.checkout, "package.json"),
      '{"dependencies":{"@opentelemetry/sdk-node":"0.300.0"}}'
    );
    await writeFile(
      join(f.checkout, "instrumentation.ts"),
      "new OTLPTraceExporter({\nurl: 'https://vendor.example/v1/traces'\n});"
    );
    await f.runtime.runPromise(
      Effect.gen(function* () {
        const settings = yield* TraceSettings;
        const runtime = yield* TraceRuntime;
        const env = yield* runtime.environment(TEST_SESSION, {});
        yield* settings.recordInstrumentation(TEST_WORKSPACE, {
          skipReason: null,
          detectedExporters: [
            DetectedTraceExporter.make({
              kind: "fixed-url",
              file: "stale.ts",
              line: 1,
              runtime: null,
              alreadyExporting: false,
            }),
          ],
        });
        expect(
          (yield* settings.get(TEST_WORKSPACE)).detectedExporters.filter(
            (item) => item.kind === "fixed-url"
          )
        ).toEqual([]);
        const ran = turn(0);
        yield* commit([
          DomainEvent.cases.TurnStarted.make({ turn: ran }),
          DomainEvent.cases.TurnItemCompleted.make({
            sessionId: TEST_SESSION,
            turnId: ran.id,
            subagentId: null,
            item: TurnItem.cases.CommandExecution.make({
              id: "app",
              startedAt: ran.startedAt,
              command: "node app.mjs",
              cwd: f.checkout,
              output: "",
              status: "completed",
              exitCode: 0,
            }),
          }),
        ]);
        expect((yield* settings.get(TEST_WORKSPACE)).detectedExporters).toContainEqual({
          kind: "fixed-url",
          file: "instrumentation.ts",
          line: 2,
          runtime: null,
          alreadyExporting: false,
        });
        const response = yield* Effect.promise(() => postTraces(env.OTEL_EXPORTER_OTLP_ENDPOINT!));
        expect(response.status).toBe(200);
        expect(
          (yield* settings.get(TEST_WORKSPACE)).detectedExporters.filter(
            (item) => item.kind === "fixed-url"
          )
        ).toEqual([]);
      })
    );
  }));

test(
  "managed-hook calls retain authority in forwarding-only mode without caller services",
  () =>
    withInstrumentation(async (f) => {
      const settings = await f.runtime.runPromise(TraceSettings);
      const runtime = await f.runtime.runPromise(TraceRuntime);
      await Effect.runPromise(
        settings.patch(TEST_WORKSPACE, { autoInstrument: "node", enabled: false, forwarding: true })
      );
      const env = await Effect.runPromise(runtime.environment(TEST_SESSION, {}));

      expect(env.NODE_OPTIONS).toMatch(/^--import /);
      expect(env.POLARIS_OTEL_ENDPOINT).toBe(env.OTEL_EXPORTER_OTLP_ENDPOINT);
    }),
  20000
);
