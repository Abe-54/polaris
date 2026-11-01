import { shortTemp } from "../../platform/testing.ts";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { TraceRuntime } from "../runtime.ts";
import { TraceSettings } from "../settings.ts";
import { TraceStore } from "../store.ts";
import { TEST_SESSION, TEST_WORKSPACE } from "../testing.ts";
import { withInstrumentation } from "../instrumentation/integration.testing.ts";
import { appendNodeImport } from "../nodeOptions.ts";
import { TargetRegistry } from "./registry.ts";

const eventually = async <A>(read: () => Promise<A>, accept: (value: A) => boolean) => {
  for (let n = 0; n < 250; n++) {
    const value = await read();

    if (accept(value)) return value;
    await Bun.sleep(20);
  }

  throw new Error("The composed Node imports did not become ready.");
};

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "runtime composition preserves a user import, real HTTP tracing and cooperative Node registration",
  async () => {
    const root = await mkdtemp(shortTemp("p9-composition-"));
    const targets = new TargetRegistry(join(root, "bootstrap"));

    try {
      await withInstrumentation(async (f) => {
        await writeFile(join(f.checkout, "package.json"), '{"name":"composed-node-app"}');
        const preload = join(f.checkout, "user import.mjs");
        const script = join(f.checkout, "app.mjs");
        const ready = join(f.checkout, "ready");
        await writeFile(preload, "process.env.P9_USER_IMPORT = 'kept';");
        await writeFile(
          script,
          `import http from 'node:http';
import { writeFileSync } from 'node:fs';
const server = http.createServer((_req,res) => res.end('composed'));
server.listen(0,'127.0.0.1', async () => {
  await (await fetch('http://127.0.0.1:'+server.address().port+'/composed')).text();
  writeFileSync(process.argv[2], process.env.P9_USER_IMPORT ?? 'missing');
});`
        );

        const source = {
          NODE_OPTIONS: appendNodeImport("--no-warnings", preload),
          OTEL_BSP_SCHEDULE_DELAY: "50",
        };

        const env = await f.runtime.runPromise(
          Effect.gen(function* () {
            yield* (yield* TraceSettings).patch(TEST_WORKSPACE, {
              autoInstrument: "node",
              forwarding: false,
            });

            return yield* (yield* TraceRuntime).environment(TEST_SESSION, source);
          })
        );

        expect(env.POLARIS_OTEL_ENDPOINT).toBe(env.OTEL_EXPORTER_OTLP_ENDPOINT);
        expect(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe(
          `${env.POLARIS_OTEL_ENDPOINT}/v1/traces`
        );
        expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(`${env.POLARIS_OTEL_ENDPOINT}/v1/logs`);

        const child = Bun.spawn([Bun.which("node")!, script, ready], {
          cwd: f.checkout,
          env: { ...process.env, ...source, ...env },
          stdout: "ignore",
          stderr: "ignore",
        });

        try {
          expect(
            await eventually(
              () =>
                Bun.file(ready)
                  .text()
                  .catch(() => ""),
              (v) => v !== ""
            )
          ).toBe("kept");

          const registered = await eventually(
            async () => {
              try {
                return targets.get(TEST_SESSION, child.pid);
              } catch {
                return null;
              }
            },
            (v) => v !== null
          );

          expect(registered?.pid).toBe(child.pid);

          const page = await eventually(
            () => f.runtime.runPromise(Effect.flatMap(TraceStore, (s) => s.list(f.checkout))),
            (v) => v.total > 0
          );

          const trace = await f.runtime.runPromise(
            Effect.flatMap(TraceStore, (s) => s.get(f.checkout, page.traces[0]!.id))
          );

          expect(trace.spans.some((span) => span.kind === "server")).toBe(true);
          expect(
            trace.spans.some((span) => span.scope.name === "@opentelemetry/instrumentation-undici")
          ).toBe(true);
          expect(
            trace.spans.every((span) => span.resource["service.name"] === "composed-node-app")
          ).toBe(true);
        } finally {
          child.kill();
          await child.exited;
        }
      }, targets);
    } finally {
      await targets.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000
);
