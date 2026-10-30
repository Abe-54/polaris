/**
 * host-address-reload: a heavy Vite page reload through Host addresses (ENG-612) next to RPC.
 * A loopback HTTP server stands in for Vite's module graph; the Client fetches every module
 * over its own byte stream, six at a time as Chromium does per host, while it times
 * `roundTrip` pings. One stream per module is the worst case for stream setup.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type ByteStreamSession, openHostAddressStream } from "@polaris/client";
import { Effect, Ref, Stream } from "effect";
import { awaitReady, connect } from "../daemon.ts";
import { settle } from "../drive.ts";
import { summarize } from "../stats.ts";
import { latency, memory, type Metric, type Scenario, time } from "../types.ts";

const PARALLEL = 6;

/** Module sizes cycle through these, like a dev graph of small files and a few big ones. */
const SIZES = [1_500, 4_000, 9_000, 2_500, 30_000, 6_000];

const moduleServer = Effect.acquireRelease(
  Effect.callback<{ port: number; server: Server }>((resume) => {
    const server = createServer((req, res) => {
      const index = Number(/\/m\/(\d+)\.js/.exec(req.url ?? "")?.[1] ?? 0);
      const body = Buffer.alloc(SIZES[index % SIZES.length] ?? 1_000, 120);

      res.writeHead(200, { "content-type": "text/javascript", "content-length": body.byteLength });
      res.end(body);
    });

    server.listen(0, "127.0.0.1", () => {
      // SAFETY: a TCP server listening on a numeric port reports an AddressInfo, not a path or null.
      const address = server.address() as AddressInfo;
      resume(Effect.succeed({ port: address.port, server }));
    });
  }),
  ({ server }) =>
    Effect.callback<void>((resume) => {
      server.closeAllConnections();
      server.close(() => resume(Effect.void));
    })
);

const request = (index: number) =>
  new TextEncoder().encode(
    `GET /m/${index}.js HTTP/1.1\r\nHost: localhost:5173\r\nConnection: close\r\n\r\n`
  );

export const hostAddressReload: Scenario = {
  name: "host-address-reload",
  description: "RPC latency while a Vite-sized reload fetches every module over Host addresses",
  run: (ctx) =>
    Effect.gen(function* () {
      const modules = ctx.quick ? 300 : 1200;
      const server = yield* moduleServer;
      const daemon = yield* ctx.launch();
      yield* awaitReady(daemon);
      const sampler = yield* ctx.sample(daemon, 50);
      const client = yield* connect(daemon, ctx.transport, "host-address-reload");

      const session: ByteStreamSession = {
        client: client.connection.client,
        blobs: client.connection.blobs,
        capabilities: client.capabilities,
      };

      const rpc: Array<{ at: number; ms: number }> = [];
      const stop = yield* Ref.make(false);

      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (!(yield* Ref.get(stop))) {
            const at = performance.now();
            const ms = yield* client.connection.roundTrip;
            rpc.push({ at, ms });
            yield* settle(20);
          }
        }).pipe(Effect.ignore)
      );

      yield* settle(1000);
      const quiet = summarize(rpc.map((r) => r.ms));
      yield* settle(500);
      const base = sampler.sample();
      const opens: Array<number> = [];
      let bytes = 0;

      const fetchModule = (index: number) =>
        Effect.scoped(
          Effect.gen(function* () {
            const started = performance.now();

            const stream = yield* openHostAddressStream(session, {
              hostname: "localhost",
              port: server.port,
            });

            opens.push(performance.now() - started);
            yield* stream.write(request(index));

            const received = yield* stream.incoming.pipe(
              Stream.runFold(
                () => 0,
                (total, chunk) => total + chunk.byteLength
              )
            );

            if (received < (SIZES[index % SIZES.length] ?? 0))
              return yield* Effect.die(new Error(`module ${index}: ${received} bytes`));
            bytes += received;
          })
        );

      const start = performance.now();

      yield* Effect.forEach(
        Array.from({ length: modules }, (_, i) => i),
        fetchModule,
        {
          concurrency: PARALLEL,
          discard: true,
        }
      );

      const end = performance.now();
      const report = sampler.report(base.t - 1, sampler.sample().t);
      yield* Ref.set(stop, true);

      const during = summarize(rpc.flatMap((r) => (r.at >= start && r.at <= end ? [r.ms] : [])));
      const open = summarize(opens);

      const metrics = {
        reload_ms: time(end - start, { tolerance: { relative: 0.5, absolute: 200 } }),
        stream_open_p50_ms: latency(open.median, { tolerance: { relative: 0.5, absolute: 5 } }),
        stream_open_p99_ms: latency(open.p99, { tolerance: { relative: 0.5, absolute: 10 } }),
        rpc_quiet_p99_ms: latency(quiet.p99, { tolerance: { relative: 0.5, absolute: 5 } }),
        rpc_during_p50_ms: latency(during.median, { tolerance: { relative: 0.5, absolute: 5 } }),
        rpc_during_p99_ms: latency(during.p99, { tolerance: { relative: 0.5, absolute: 20 } }),
        rpc_during_max_ms: latency(during.max, { tolerance: { relative: 0.5, absolute: 50 } }),
        rss_peak_over_base_mib: memory(report.rssBytes.max - base.rssBytes, {
          tolerance: { relative: 0.35, absolute: 16 },
        }),
      } satisfies Record<string, Metric>;

      return {
        metrics,
        notes: [
          `${modules} modules (${(bytes / 1e6).toFixed(1)} MB) over ${ctx.transport}, one stream each, ${PARALLEL} at a time; roundTrip pings every 20 ms, ${during.n} of them during the reload`,
        ],
      };
    }),
};
