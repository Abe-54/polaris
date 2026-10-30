/**
 * byte-streams: a large Host-address transfer (ENG-613, ADR 0093) next to RPC. The Daemon
 * streams bytes from a loopback server to the Client over the blob channel while the Client
 * times `roundTrip` pings. Credit-based flow control must keep the pings fast: a big transfer
 * may not starve the JSON RPC frames sharing the wire.
 */
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { type ByteStreamSession, openHostAddressStream } from "@polaris/client";
import { Effect, Ref, Stream } from "effect";
import { awaitReady, connect } from "../daemon.ts";
import { settle } from "../drive.ts";
import { summarize } from "../stats.ts";
import { latency, memory, type Metric, type Scenario, throughput } from "../types.ts";

const CHUNK = 64 * 1024;

/** A loopback server that streams `size` bytes to each connection, then ends; closed with the scope. */
const firehose = (size: number) =>
  Effect.acquireRelease(
    Effect.callback<{ port: number; server: Server }>((resume) => {
      const server = createServer((socket: Socket) => {
        socket.on("error", () => {});
        let sent = 0;

        const pump = () => {
          while (sent < size) {
            // A fresh buffer per write: Node keeps the reference while backpressured.
            const chunk = Buffer.allocUnsafe(Math.min(CHUNK, size - sent));
            sent += chunk.byteLength;

            if (!socket.write(chunk)) return socket.once("drain", pump);
          }

          socket.end();
        };

        pump();
      });

      server.listen(0, "127.0.0.1", () => {
        // SAFETY: a TCP server listening on a numeric port reports an AddressInfo, not a path or null.
        const address = server.address() as AddressInfo;
        resume(Effect.succeed({ port: address.port, server }));
      });
    }),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      })
  );

export const byteStreams: Scenario = {
  name: "byte-streams",
  description: "RPC latency while a Host-address byte stream transfers over the blob channel",
  run: (ctx) =>
    Effect.gen(function* () {
      const size = (ctx.quick ? 16 : 100) * 1024 * 1024;
      const server = yield* firehose(size);
      const daemon = yield* ctx.launch();
      yield* awaitReady(daemon);
      const sampler = yield* ctx.sample(daemon, 50);
      const client = yield* connect(daemon, ctx.transport, "byte-streams");

      const session: ByteStreamSession = {
        client: client.connection.client,
        blobs: client.connection.blobs,
        capabilities: client.capabilities,
      };

      // A ping every 20 ms, timed, for the whole run.
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

      // Open the stream and drain every byte, timing the transfer.
      const start = performance.now();

      const stream = yield* openHostAddressStream(session, {
        hostname: "127.0.0.1",
        port: server.port,
      });

      const received = yield* stream.incoming.pipe(
        Stream.runFold(
          () => 0,
          (total, chunk) => total + chunk.byteLength
        )
      );

      const seconds = (performance.now() - start) / 1000;
      const end = performance.now();

      if (received !== size)
        return yield* Effect.die(new Error(`drained ${received} of ${size} bytes`));

      const report = sampler.report(base.t - 1, sampler.sample().t);
      yield* Ref.set(stop, true);

      const during = summarize(rpc.flatMap((r) => (r.at >= start && r.at <= end ? [r.ms] : [])));
      const mb = size / 1e6;

      const metrics = {
        transfer_mb_per_s: throughput(mb / seconds, "MB/s", {
          tolerance: { relative: 0.5, absolute: 0 },
        }),
        rpc_quiet_p99_ms: latency(quiet.p99, { tolerance: { relative: 0.5, absolute: 5 } }),
        rpc_during_p50_ms: latency(during.median, { tolerance: { relative: 0.5, absolute: 5 } }),
        rpc_during_p99_ms: latency(during.p99, { tolerance: { relative: 0.5, absolute: 20 } }),
        rpc_during_max_ms: latency(during.max, { tolerance: { relative: 0.5, absolute: 50 } }),
        rss_peak_over_base_mib: memory(report.rssBytes.max - base.rssBytes, {
          tolerance: { relative: 0.35, absolute: size / 1024 / 1024 / 4 },
        }),
      } satisfies Record<string, Metric>;

      return {
        metrics,
        notes: [
          `${size / 1024 / 1024} MiB from a loopback server over ${ctx.transport}; roundTrip pings every 20 ms, ${during.n} of them during the transfer`,
        ],
      };
    }),
};
