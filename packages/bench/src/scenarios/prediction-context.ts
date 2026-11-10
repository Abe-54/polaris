import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { connectRpc, socketTransport, spawnTransport } from "@polaris/client";
import { awaitReady, cleanup, createTempDir } from "../daemon.ts";
import { registerWorkspace, settle } from "../drive.ts";
import { summarize } from "../stats.ts";
import { count, cpu, latency, memory, type Metric, rss, type Scenario } from "../types.ts";

export const predictionContext: Scenario = {
  name: "prediction-context",
  description:
    "Host context RPC with local imports before Trust; cold, warm, edit invalidation and idle",
  run: (ctx) =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.sync(() => createTempDir("prediction")),
        (dir) => Effect.sync(() => cleanup(dir))
      );

      const file = join(root, "editor.ts");
      const dependency = join(root, "dependency.ts");
      const buffer = 'import { greet } from "./dependency";\nconst result = greet(';
      yield* Effect.promise(async () => {
        await writeFile(file, buffer);
        await writeFile(
          dependency,
          "export function greet(name: string): string { return `Hello ${name}`; }"
        );
      });
      const daemon = yield* ctx.launch();
      yield* awaitReady(daemon);

      const transport =
        ctx.transport === "socket"
          ? yield* socketTransport(daemon.socketPath)
          : yield* spawnTransport(daemon.bridgeArgv, { env: daemon.bridgeEnv });

      const connection = yield* connectRpc(transport);

      const hello = yield* connection.client.hello({
        clientName: "prediction-context",
        clientVersion: "0",
        deviceLabel: "bench",
        capabilities: ["prediction.context"],
        languageProof: Redacted.make("c".repeat(64)),
      });

      const client = { connection, label: "prediction-context", capabilities: hello.capabilities };
      const workspaceId = yield* registerWorkspace(client, root, "prediction-context");

      const input = {
        workspaceId,
        path: file,
        buffer,
        cursor: buffer.length,
        recentEdits: [],
        budgetTokens: 2048,
      };

      const rpc = client.connection.client;
      const coldStart = performance.now();
      const cold = yield* rpc["prediction.context"](input);
      const coldMs = performance.now() - coldStart;
      const timings: number[] = [];

      for (let index = 0; index < (ctx.quick ? 30 : 120); index++) {
        const at = performance.now();
        const result = yield* rpc["prediction.context"](input);

        if (result.length === 0)
          return yield* Effect.die(new Error("Prediction context returned no outline"));
        timings.push(performance.now() - at);
      }

      yield* Effect.promise(() =>
        writeFile(dependency, "export function changed(input: number): boolean { return true; }")
      );
      const edited = yield* rpc["prediction.context"](input);

      if (!edited.some((piece) => piece.text.includes("changed")))
        return yield* Effect.die(new Error("Imported edit did not invalidate prediction context"));
      const sampler = yield* ctx.sample(daemon, 500);
      yield* settle(ctx.quick ? 3000 : 10000);
      const from = sampler.sample().t;
      yield* settle(ctx.quick ? 3000 : 10000);
      const idle = sampler.report(from - 1, sampler.sample().t);
      const summary = summarize(timings);

      const metrics: Record<string, Metric> = {};

      Object.assign(metrics, {
        cold_ms: latency(coldMs),
        warm_p50_ms: latency(summary.median),
        warm_p95_ms: latency(summary.p95),
        pieces: count(cold.length, "pieces"),
        idle_cpu_pct: cpu(idle.cpuAvgPct),
        idle_rss_mib: rss(memory(idle.rssBytes.median)),
      } satisfies Record<string, Metric>);

      if (idle.footprintBytes) metrics.idle_footprint_mib = memory(idle.footprintBytes.median);

      return {
        metrics,
        notes: [
          "Real context RPC, no Trust or language server; warm repeated buffer plus imported-file invalidation. Model server unused.",
          "Cold includes first lazy Host language graph and parser load. Shared machine; compare integration on a quiet Host.",
        ],
      };
    }),
};
