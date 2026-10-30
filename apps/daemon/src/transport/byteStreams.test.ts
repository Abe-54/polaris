/**
 * Byte streams over a real Daemon (ENG-613, ADR 0092, 0093): Host-address streams to a
 * loopback TCP server through the local socket and through `polaris bridge`, the refusals,
 * close on disconnect, credit-based backpressure, and Browser hosting between two Desktop
 * App connections, with the ownership checks on accept, close and credit.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Socket } from "node:net";
import {
  type ByteStreamSession,
  connectRpc,
  hostBrowsers,
  openHostAddressStream,
  socketTransport,
} from "@polaris/client";
import {
  BYTE_STREAM_WINDOW_BYTES,
  type ByteStreamId,
  type ByteTransport,
  SessionId,
} from "@polaris/protocol";
import { Effect, Exit, Fiber, Predicate, Queue, Scope, Stream } from "effect";
import {
  bytes,
  cleanupHome,
  client,
  CLIENT_CAPABILITIES,
  collectAll,
  daemon,
  echoServer,
  endpoint,
  eventually,
  freshHome,
  hardConnection,
  roundTrip,
  run,
  sha,
  tcpServer,
} from "./byteStreamsHarness.ts";

beforeEach(freshHome);

afterEach(cleanupHome);

describe("Host-address streams", () => {
  test.each(["socket", "bridge"] as const)(
    "echo 3 MiB through localhost and a *.localhost name over the %s transport",
    async (transport) => {
      const result = await run(
        Effect.gen(function* () {
          yield* daemon();
          const echo = yield* echoServer;
          const session = yield* client(transport);
          const payload = bytes(3 * 1024 * 1024, 11);

          const viaLocalhost = yield* openHostAddressStream(session, {
            hostname: "localhost",
            port: echo.port,
          });

          const viaApp = yield* openHostAddressStream(session, {
            hostname: "app.localhost.",
            port: echo.port,
          });

          const [a, b] = yield* Effect.all(
            [roundTrip(viaLocalhost, payload), roundTrip(viaApp, bytes(64 * 1024, 5))],
            { concurrency: "unbounded" }
          );

          yield* viaLocalhost.close;
          yield* viaApp.close;
          const closed = yield* eventually(() => echo.connections.closed === 2);

          return {
            a: sha(a),
            b: sha(b),
            payload: sha(payload),
            opened: echo.connections.opened,
            closed,
          };
        })
      );

      expect(result.a).toBe(result.payload);
      expect(result.b).toBe(sha(bytes(64 * 1024, 5)));
      expect(result.opened).toBe(2);
      // Closing the transport closes the Daemon's socket.
      expect(result.closed).toBe(true);
    },
    30_000
  );

  test("names that are not Host addresses are refused before any socket opens; a closed port is refused", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* daemon();
        const echo = yield* echoServer;
        const session = yield* client("socket");

        const refused = yield* Effect.forEach(
          ["evil.example", "myhost.lan", "192.168.1.10", "localhost.evil.example"],
          (hostname) =>
            openHostAddressStream(session, { hostname, port: echo.port }).pipe(
              Effect.flip,
              Effect.map((error) =>
                Predicate.isTagged(error, "HostAddressError") ? error.reason : error._tag
              )
            )
        );

        // A port with nothing listening: the loopback connect fails, and says so.
        const closedPort = yield* tcpServer(() => {});
        const port = closedPort.port;
        yield* Effect.callback<void>((resume) => {
          closedPort.server.close(() => resume(Effect.void));
        });

        const unreachable = yield* openHostAddressStream(session, {
          hostname: "127.0.0.1",
          port,
        }).pipe(Effect.flip);

        return {
          refused,
          opened: echo.connections.opened,
          unreachable: Predicate.isTagged(unreachable, "HostAddressError")
            ? unreachable.reason
            : unreachable._tag,
        };
      })
    );

    expect(result.refused).toEqual([
      "not-host-address",
      "not-host-address",
      "not-host-address",
      "not-host-address",
    ]);
    expect(result.opened).toBe(0);
    expect(result.unreachable).toBe("refused");
  });

  test("a stream ends with its connection, in both directions", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* daemon();
        let held: Socket | null = null;

        const server = yield* tcpServer((socket) => {
          held = socket;
          socket.on("data", () => {});
        });

        // The Client disconnects: the Daemon closes its loopback socket.
        const connectionScope = yield* Scope.make();
        const session = yield* client("socket").pipe(Scope.provide(connectionScope));

        const stream = yield* openHostAddressStream(session, {
          hostname: "localhost",
          port: server.port,
        });

        yield* stream.write(bytes(10, 1));
        yield* eventually(() => server.connections.opened === 1);
        yield* Scope.close(connectionScope, Exit.void);
        const socketClosed = yield* eventually(() => server.connections.closed === 1);

        // The Host's server closes its socket: the Client's incoming ends.
        const second = yield* client("socket", { key: "second" });

        const other = yield* openHostAddressStream(second, {
          hostname: "localhost",
          port: server.port,
        });

        yield* other.write(bytes(10, 2));
        yield* eventually(() => server.connections.opened === 2);
        const drained = yield* Effect.forkChild(collectAll(other.incoming).pipe(Effect.exit));
        held!.destroy();
        const incomingEnded = yield* Fiber.join(drained);

        return { socketClosed, incomingEnded: Exit.isSuccess(incomingEnded) };
      })
    );

    expect(result.socketClosed).toBe(true);
    expect(result.incomingEnded).toBe(true);
  }, 15_000);

  test("a sender never has more than one window in flight, so RPCs keep flowing beside a stalled transfer", async () => {
    const TOTAL = 8 * 1024 * 1024;

    const result = await run(
      Effect.gen(function* () {
        yield* daemon();

        // A server that writes 8 MiB as fast as the socket takes it, then ends.
        const firehose = yield* tcpServer((socket) => {
          let sent = 0;

          const pump = () => {
            while (sent < TOTAL) {
              // A fresh buffer per write: Node keeps the reference while backpressured.
              const chunk = bytes(64 * 1024, sent % 97);
              sent += chunk.byteLength;

              if (!socket.write(chunk)) return socket.once("drain", pump);
            }

            socket.end();
          };

          pump();
        });

        const transport = yield* socketTransport(endpoint());
        const connection = yield* connectRpc(transport);

        const hello = yield* connection.client.hello({
          clientName: "test",
          clientVersion: "0",
          deviceLabel: "stall",
          capabilities: CLIENT_CAPABILITIES,
        });

        const session = {
          client: connection.client,
          blobs: connection.blobs,
          capabilities: hello.capabilities,
        };

        const stream = yield* openHostAddressStream(session, {
          hostname: "localhost",
          port: firehose.port,
        });

        // Read nothing for a while: the Daemon may send one window and must then wait.
        yield* Effect.sleep("600 millis");
        const stalled = connection.wire.stats().bufferedBlobBytes;
        const started = performance.now();
        yield* connection.roundTrip;
        const pingMs = performance.now() - started;

        // Now drain it all; the credits let the rest through.
        const total = yield* collectAll(stream.incoming);

        return { stalled, pingMs, total };
      })
    );

    expect(result.stalled).toBeGreaterThan(0);
    expect(result.stalled).toBeLessThanOrEqual(BYTE_STREAM_WINDOW_BYTES);
    expect(result.pingMs).toBeLessThan(500);
    expect(result.total).toBe(TOTAL);
  }, 20_000);

  test("a Client's write past the Daemon's window waits for the Host to read", async () => {
    // Far more than any loopback kernel buffer: once the Host stops reading, the Daemon's
    // socket fills, it grants no more credit, and the Client's write cannot finish.
    const TOTAL = 32 * BYTE_STREAM_WINDOW_BYTES;

    const result = await run(
      Effect.gen(function* () {
        yield* daemon();
        let held: Socket | null = null;

        const slow = yield* tcpServer((socket) => {
          held = socket;
          socket.pause();
        });

        const session = yield* client("socket");

        const stream = yield* openHostAddressStream(session, {
          hostname: "localhost",
          port: slow.port,
        });

        yield* eventually(() => held !== null);

        let done = false;

        const write = yield* Effect.forkChild(
          stream.write(bytes(TOTAL, 9)).pipe(Effect.ensuring(Effect.sync(() => (done = true))))
        );

        yield* Effect.sleep("400 millis");
        const blocked = !done;
        let read = 0;
        held!.on("data", (chunk: Buffer) => {
          read += chunk.byteLength;
        });
        held!.resume();
        yield* Fiber.join(write);
        const drained = yield* eventually(() => read === TOTAL);

        return { blocked, drained };
      })
    );

    expect(result.blocked).toBe(true);
    expect(result.drained).toBe(true);
  }, 15_000);

  test("credit for bytes never sent ends the stream; the quota caps streams per connection", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* daemon({ quota: 2 });
        const echo = yield* echoServer;
        const session = yield* client("socket");
        const opens: Array<ByteStreamId> = [];

        // The Daemon's stream id is in `Opened`; catch it from the raw RPC to credit by hand.
        const upstream = yield* session.blobs.offer(Stream.never);

        const raw = yield* Effect.forkChild(
          session.client["hostAddress.open"]({
            hostname: "localhost",
            port: echo.port,
            upstream,
            window: BYTE_STREAM_WINDOW_BYTES,
          }).pipe(
            Stream.tap((item) =>
              Effect.sync(() => {
                if (Predicate.isTagged(item, "Opened")) opens.push(item.streamId);
              })
            ),
            Stream.runDrain,
            Effect.exit
          )
        );

        yield* eventually(() => opens.length === 1);

        const second = yield* openHostAddressStream(session, {
          hostname: "localhost",
          port: echo.port,
        });

        const third = yield* openHostAddressStream(session, {
          hostname: "localhost",
          port: echo.port,
        }).pipe(
          Effect.flip,
          Effect.map((e) => (Predicate.isTagged(e, "HostAddressError") ? e.reason : e._tag))
        );

        // Nothing was sent on the first stream yet, so any credit is too much.
        const overCredit = yield* session.client["byteStream.credit"]({
          streamId: opens[0]!,
          bytes: 1,
        }).pipe(Effect.flip);

        yield* second.close;
        const afterClose = yield* eventually(() => echo.connections.closed >= 1);

        // The failed stream's finalizer ran: a slot is free again.
        const reopened = yield* openHostAddressStream(session, {
          hostname: "localhost",
          port: echo.port,
        }).pipe(
          Effect.as("opened"),
          Effect.catch((e) => Effect.succeed(e._tag))
        );

        return {
          third,
          overCredit: overCredit._tag,
          afterClose,
          reopened,
          raw: yield* Fiber.join(raw),
        };
      })
    );

    expect(result.third).toBe("too-many-streams");
    expect(result.overCredit).toBe("NotFound");
    expect(result.afterClose).toBe(true);
    expect(result.reopened).toBe("opened");
  }, 15_000);
});

describe("Browser hosting", () => {
  const s1 = SessionId.make("s1");

  const s2 = SessionId.make("s2");

  /** The Desktop App side: hosts, and answers every offer as `mode` says (accepted ones land in `accepted`). */
  const desktop = (session: ByteStreamSession, mode: "accept" | "refuse" | "ignore" = "accept") =>
    Effect.gen(function* () {
      const host = yield* hostBrowsers(session);
      const accepted = yield* Queue.unbounded<ByteTransport>();
      const offered: Array<{ sessionId: SessionId; streamId: ByteStreamId }> = [];

      yield* host.offers.pipe(
        Stream.runForEach((offer) =>
          Effect.gen(function* () {
            offered.push({ sessionId: offer.sessionId, streamId: offer.streamId });

            if (mode === "refuse") return yield* offer.refuse;

            if (mode === "ignore") return;
            const transport = yield* offer.accept;
            yield* Queue.offer(accepted, transport);
          }).pipe(Effect.ignore)
        ),
        Effect.forkScoped
      );

      return { session, host, accepted, offered };
    });

  test("no Desktop App: NoDesktopApp; one that didn't announce browser.host is refused", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { hosting } = yield* daemon();
        const none = yield* hosting.open(s1, "cdp").pipe(Effect.flip);
        const plain = yield* client("socket", { capabilities: ["blobs", "host-address"] });

        const unsupported = yield* plain.client["browser.host"]({}).pipe(
          Stream.runDrain,
          Effect.flip
        );

        const claim = yield* plain.client["browser.claim"]({ sessionId: s1 }).pipe(Effect.flip);

        return {
          none: none._tag,
          message: none.message,
          unsupported: unsupported._tag,
          claim: claim._tag,
        };
      })
    );

    expect(result.none).toBe("NoDesktopApp");
    expect(result.message).toBe("No Desktop App is connected to show this Browser.");
    expect(result.unsupported).toBe("Unsupported");
    expect(result.claim).toBe("Unsupported");
  });

  test.each(["socket", "bridge"] as const)(
    "a Browser stream carries bytes both ways between the Daemon and the hosting Desktop App (%s)",
    async (transport) => {
      const result = await run(
        Effect.gen(function* () {
          const { hosting } = yield* daemon();
          const mac = yield* desktop(yield* client(transport));
          yield* mac.host.claim(s1);
          const payload = bytes(2 * 1024 * 1024, 4);

          const daemonSide = yield* hosting.open(s1, "cdp");
          const macSide = yield* Queue.take(mac.accepted);
          // The Desktop App echoes.
          yield* macSide.incoming.pipe(Stream.runForEach(macSide.write), Effect.forkScoped);

          const echoed = yield* roundTrip(daemonSide, payload);
          yield* daemonSide.close;

          return { echoed: sha(echoed), payload: sha(payload), offered: mac.offered };
        })
      );

      expect(result.echoed).toBe(result.payload);
      expect(result.offered.map((o) => o.sessionId)).toEqual([s1]);
    },
    30_000
  );

  test("streams go to the last claimer, else the most recently present host; a move revokes", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { hosting } = yield* daemon();
        const mac = yield* desktop(yield* client("socket", { key: "mac" }));
        const laptopSession = yield* client("socket", { key: "laptop" });
        const laptop = yield* desktop(laptopSession);

        // No claim: the host where the user was present last.
        yield* laptopSession.client["presence.report"]({ presence: "present" });
        const unclaimed = yield* hosting.current(s2);

        yield* mac.host.claim(s1);
        const first = yield* hosting.open(s1, "cdp");
        const macSide = yield* Queue.take(mac.accepted);
        const macIncoming = yield* Effect.forkChild(collectAll(macSide.incoming).pipe(Effect.exit));
        const firstIncoming = yield* Effect.forkChild(collectAll(first.incoming).pipe(Effect.exit));

        // The laptop shows the Browser now: the mac's stream for s1 is revoked, new ones go there.
        yield* laptop.host.claim(s1);
        const revokedOnMac = yield* Fiber.join(macIncoming);
        const revokedOnDaemon = yield* Fiber.join(firstIncoming);
        const second = yield* hosting.open(s1, "cdp");
        yield* Queue.take(laptop.accepted);
        yield* second.close;

        return {
          unclaimed: unclaimed === (yield* hosting.current(s1)) ? "laptop" : "other",
          revokedOnMac: Exit.isFailure(revokedOnMac),
          revokedOnDaemon: Exit.isFailure(revokedOnDaemon),
          offered: {
            mac: mac.offered.map((o) => o.sessionId),
            laptop: laptop.offered.map((o) => o.sessionId),
          },
        };
      })
    );

    expect(result.unclaimed).toBe("laptop");
    expect(result.revokedOnMac).toBe(true);
    expect(result.revokedOnDaemon).toBe(true);
    expect(result.offered).toEqual({ mac: [s1], laptop: [s1] });
  }, 15_000);

  test("another connection cannot accept, close or credit a stream; duplicate and stale answers are refused", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { hosting } = yield* daemon();
        const mac = yield* desktop(yield* client("socket", { key: "mac" }));
        const other = yield* desktop(yield* client("socket", { key: "other" }), "ignore");
        yield* mac.host.claim(s1);

        const daemonSide = yield* hosting.open(s1, "cdp");
        const macSide = yield* Queue.take(mac.accepted);
        yield* macSide.incoming.pipe(Stream.runForEach(macSide.write), Effect.forkScoped);
        const streamId = mac.offered[0]!.streamId;
        const otherBlob = yield* other.session.blobs.offer(Stream.never);
        const macBlob = yield* mac.session.blobs.offer(Stream.never);
        const tag = (e: { readonly _tag: string }) => e._tag;

        const foreign = yield* Effect.all({
          accept: other.session.client["browser.acceptStream"]({
            streamId,
            upstream: otherBlob,
            window: BYTE_STREAM_WINDOW_BYTES,
          }).pipe(Effect.flip, Effect.map(tag)),
          close: other.session.client["browser.closeStream"]({ streamId, reason: "closed" }).pipe(
            Effect.flip,
            Effect.map(tag)
          ),
          credit: other.session.client["byteStream.credit"]({ streamId, bytes: 1 }).pipe(
            Effect.flip,
            Effect.map(tag)
          ),
        });

        const duplicate = yield* mac.session.client["browser.acceptStream"]({
          streamId,
          upstream: macBlob,
          window: BYTE_STREAM_WINDOW_BYTES,
        }).pipe(Effect.flip, Effect.map(tag));

        // The stream survived every refusal.
        const echoed = yield* roundTrip(daemonSide, bytes(1000, 8));

        // Over-credit from the owner ends the stream; afterwards its id is stale.
        const over = yield* mac.session.client["byteStream.credit"]({
          streamId,
          bytes: BYTE_STREAM_WINDOW_BYTES,
        }).pipe(Effect.flip, Effect.map(tag));

        const ended = yield* collectAll(daemonSide.incoming).pipe(Effect.exit);

        const stale = yield* mac.session.client["browser.closeStream"]({
          streamId,
          reason: "closed",
        }).pipe(Effect.flip, Effect.map(tag));

        return {
          foreign,
          duplicate,
          echoed: echoed.byteLength,
          over,
          ended: Exit.isFailure(ended),
          stale,
        };
      })
    );

    expect(result.foreign).toEqual({ accept: "NotFound", close: "NotFound", credit: "NotFound" });
    expect(result.duplicate).toBe("NotFound");
    expect(result.echoed).toBe(1000);
    expect(result.over).toBe("NotFound");
    expect(result.ended).toBe(true);
    expect(result.stale).toBe("NotFound");
  }, 15_000);

  test("a refused or unanswered offer fails the open; a host's streams end with its connection", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { hosting } = yield* daemon({ acceptTimeout: "300 millis" });
        const refusing = yield* desktop(yield* client("socket", { key: "refusing" }), "refuse");
        yield* refusing.host.claim(s1);
        const refused = yield* hosting.open(s1, "cdp").pipe(Effect.flip);

        const silent = yield* desktop(yield* client("socket", { key: "silent" }), "ignore");
        yield* silent.host.claim(s1);
        const started = performance.now();
        const unanswered = yield* hosting.open(s1, "cdp").pipe(Effect.flip);
        const waitedMs = performance.now() - started;

        // An accepted stream, then the hosting connection drops hard (no graceful close).
        const dropping = yield* hardConnection();
        const droppingHost = yield* desktop(dropping.session);

        yield* droppingHost.host.claim(s2);
        const stream = yield* hosting.open(s2, "cdp");
        yield* Queue.take(droppingHost.accepted);
        const reading = yield* Effect.forkChild(collectAll(stream.incoming).pipe(Effect.exit));
        dropping.drop();
        const ended = yield* Fiber.join(reading);

        const gone = yield* hosting.current(s2).pipe(
          Effect.flip,
          Effect.map((e) => e._tag),
          Effect.orElseSucceed(() => "present")
        );

        return {
          refused: refused._tag,
          unanswered: unanswered._tag,
          waitedMs,
          ended: Exit.isFailure(ended),
          gone,
        };
      })
    );

    expect(result.refused).toBe("BrowserStreamRefused");
    expect(result.unanswered).toBe("BrowserStreamRefused");
    expect(result.waitedMs).toBeGreaterThanOrEqual(250);
    expect(result.ended).toBe(true);
    // s2 was never claimed and the claimed host dropped, but the refusing and silent hosts remain.
    expect(result.gone).toBe("present");
  }, 15_000);
});
