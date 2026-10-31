import { join } from "node:path";
import { SessionId } from "@polaris/protocol";
import { Effect, Option, Stream } from "effect";
import { awaitReady, cleanup, connect, createTempDir } from "../daemon.ts";
import { registerWorkspace, settle, startSession, waitUntil, watchSession } from "../drive.ts";
import { smallRepo } from "../fixtures.ts";
import { cpu, latency, memory, peakMemory, type Scenario, throughput, time } from "../types.ts";

const batch = (index: number) => {
  const traceId = (index + 1).toString(16).padStart(32, "0");
  const start = BigInt(Date.now()) * 1_000_000n;

  const spans = Array.from({ length: 1000 }, (_, i) => ({
    traceId,
    spanId: (i + 1).toString(16).padStart(16, "0"),
    parentSpanId: i === 0 ? "" : "0000000000000001",
    name: i === 0 ? "GET /bench" : "db.query",
    kind: i === 0 ? 2 : 3,
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: (start + 1_000_000n).toString(),
    attributes: [{ key: "db.system", value: { stringValue: "postgresql" } }],
  }));

  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "bench" } }] },
        scopeSpans: [{ spans }],
      },
    ],
  });
};

export const traces: Scenario = {
  name: "traces",
  description:
    "200k OTLP spans through the real receiver and worker; throughput, RSS and concurrent RPC latency",
  run: (ctx) =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.sync(() => createTempDir("traces")),
        (dir) => Effect.sync(() => cleanup(dir))
      );

      const cwd = smallRepo(join(root, "repo"));
      const daemon = yield* ctx.launch();
      yield* awaitReady(daemon);
      const client = yield* connect(daemon, ctx.transport, "traces");
      const rpc = client.connection.client;
      const workspaceId = yield* registerWorkspace(client, cwd, "traces");
      const sessionId = SessionId.make("trace-bench");
      yield* startSession(client, { sessionId, workspaceId, script: { items: 1 } });
      const watch = yield* watchSession(client, sessionId);
      yield* waitUntil(() => watch.turnEnded.length > 0, 10_000, "trace session");
      const setup = yield* rpc["traces.watch"]({ sessionId }).pipe(Stream.runHead);
      const endpoint = Option.getOrThrow(setup).endpoint;

      if (endpoint === null)
        return yield* Effect.die(new Error("Trace receiver unavailable; port 4319 must be free"));
      const sampler = yield* ctx.sample(daemon, 50);
      yield* settle(1000);
      const base = sampler.sample();
      const latencies: number[] = [];
      const count = ctx.quick ? 20 : 200;
      const began = performance.now();

      for (let i = 0; i < count; i++) {
        const payload = batch(i);
        yield* Effect.all(
          [
            Effect.promise(async () => {
              const response = await fetch(`${endpoint}/v1/traces`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: payload,
              });

              await response.arrayBuffer();

              if (response.status !== 200) throw new Error(`OTLP status ${response.status}`);
            }),
            Effect.gen(function* () {
              const at = performance.now();
              yield* rpc["files.stat"]({ path: cwd });
              latencies.push(performance.now() - at);
            }),
          ],
          { concurrency: "unbounded" }
        );
      }
      // A read flushes every accepted batch before timing ingest completion.

      const last = yield* rpc["traces.get"]({
        sessionId,
        traceId: count.toString(16).padStart(32, "0"),
      });

      if (last.spans.length !== 1000) return yield* Effect.die(new Error("Trace batch lost spans"));
      const elapsed = performance.now() - began;
      const report = sampler.report(base.t - 1, sampler.sample().t);
      yield* settle(32_000);
      const settled = sampler.sample();
      latencies.sort((a, b) => a - b);

      return {
        metrics: {
          spans_per_s: throughput((count * 1000) / (elapsed / 1000), "spans/s"),
          ingest_ms: time(elapsed),
          cpu_avg_pct: cpu(report.cpuAvgPct),
          rss_peak_over_base_mib: peakMemory(report.rssBytes.max - base.rssBytes),
          rss_after_quiet_mib: memory(settled.rssBytes),
          rpc_during_p99_ms: latency(latencies[Math.ceil(latencies.length * 0.99) - 1]!),
        },
        notes: [
          `${count * 1000} spans in ${count} JSON batches; real receiver, SQLite worker, concurrent files.stat; 32s quiet worker retirement.`,
        ],
      };
    }),
};
