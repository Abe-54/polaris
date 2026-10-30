/**
 * How a Host-address stream ends when the loopback peer misbehaves (ENG-613, the Codex review of
 * d23fa0b6): a mid-exchange reset must fail the Client's read rather than read as a short clean
 * body, and a Client disconnect must terminate a loopback socket whose Host stopped reading
 * instead of waiting forever for a drain that never comes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Socket } from "node:net";
import { openHostAddressStream } from "@polaris/client";
import { BYTE_STREAM_WINDOW_BYTES } from "@polaris/protocol";
import { Effect, Exit, Fiber, Scope } from "effect";
import { connectTcp } from "./bunSocket.ts";
import {
  bytes,
  cleanupHome,
  client,
  collectAll,
  daemon,
  eventually,
  freshHome,
  run,
  tcpServer,
} from "./byteStreamsHarness.ts";

beforeEach(freshHome);

afterEach(cleanupHome);

describe("Host-address streams: misbehaving peers", () => {
  test("a Host that resets mid-exchange fails the Client's read, not a short clean body", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* daemon();
        let held: Socket | null = null;

        // A Host that sends a partial response and never reads the request: the Daemon's writes
        // to it pile up, so a reset breaks a write in flight.
        const server = yield* tcpServer((socket) => {
          held = socket;
          socket.on("error", () => {});
          socket.pause();
          socket.write(bytes(64 * 1024, 3));
        });

        const session = yield* client("socket");

        const stream = yield* openHostAddressStream(session, {
          hostname: "localhost",
          port: server.port,
        });

        yield* Effect.forkChild(stream.write(bytes(8 * 1024 * 1024, 7)).pipe(Effect.ignore));
        const reading = yield* Effect.forkChild(collectAll(stream.incoming).pipe(Effect.exit));
        yield* eventually(() => held !== null);
        yield* Effect.sleep("150 millis");

        // A reset, not a graceful close.
        held!.destroy();
        const ended = yield* Fiber.join(reading);

        return { failed: Exit.isFailure(ended) };
      })
    );

    expect(result.failed).toBe(true);
  }, 15_000);

  test("a disconnect terminates a loopback socket whose Host stopped reading, instead of waiting to drain", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* daemon();

        // A Host that accepts the connection but never reads: the Daemon's writes pile up.
        const stuck = yield* tcpServer((socket) => {
          socket.pause();
        });

        const connectionScope = yield* Scope.make();
        const session = yield* client("socket").pipe(Scope.provide(connectionScope));

        const stream = yield* openHostAddressStream(session, {
          hostname: "localhost",
          port: stuck.port,
        });

        yield* Effect.forkChild(
          stream.write(bytes(32 * BYTE_STREAM_WINDOW_BYTES, 9)).pipe(Effect.ignore)
        );
        yield* eventually(() => stuck.connections.opened === 1);
        yield* Effect.sleep("300 millis");

        // The Client drops: the Daemon must terminate its stuck loopback socket, not wait for a
        // drain that will never come.
        yield* Scope.close(connectionScope, Exit.void);
        const closed = yield* eventually(() => stuck.connections.closed === 1);

        return { closed };
      })
    );

    expect(result.closed).toBe(true);
  }, 15_000);

  test("a graceful scope close drains queued bytes to the peer instead of truncating them", async () => {
    // Far more than the loopback socket buffers hold, so a large tail sits in the stream's pending
    // queue when the scope closes: a graceful close must flush it, not reset and discard it.
    const payload = bytes(16 * 1024 * 1024, 2);

    const result = await run(
      Effect.gen(function* () {
        let received = 0;
        let peer: import("node:net").Socket | null = null;

        const server = yield* tcpServer((socket) => {
          peer = socket;
          socket.pause();
          socket.on("data", (chunk: Buffer) => {
            received += chunk.byteLength;
          });
        });

        const scope = yield* Scope.make();
        const transport = yield* connectTcp("127.0.0.1", server.port).pipe(Scope.provide(scope));
        const write = yield* Effect.forkChild(transport.write(payload).pipe(Effect.exit));
        yield* eventually(() => peer !== null);
        yield* Effect.sleep("150 millis");

        // Close the scope cleanly while bytes are still queued, then let the peer read.
        yield* Scope.close(scope, Exit.void);
        peer!.resume();
        yield* Fiber.join(write);
        const drained = yield* eventually(() => received === payload.byteLength);

        return { drained, received };
      })
    );

    expect(result.drained).toBe(true);
    expect(result.received).toBe(payload.byteLength);
  }, 20_000);
});
