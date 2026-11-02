import { expect, test } from "bun:test";
import { connect } from "node:net";
import { MAX_FRAME_BYTES } from "@polaris/protocol";
import { Effect, Stream } from "effect";
import { startGateway } from "./server.ts";
import { requestBudget } from "./limits.ts";

const openSocket = (url: string) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<WebSocket>((resolve, reject) => {
          const socket = new WebSocket(url);
          socket.onopen = () => resolve(socket);
          socket.onerror = () => reject(new Error("upgrade refused"));
        })
    ),
    (socket) => Effect.sync(() => socket.close())
  );

test("connection saturation refuses upgrades and a closed socket releases capacity", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* startGateway({ port: 0, recordPath: null });

        if (gateway === null) throw new Error("no gateway");
        yield* gateway.connections.pipe(
          Stream.runForEach((t) => Effect.sync(t.authenticated)),
          Effect.forkScoped
        );
        const sockets: Array<WebSocket> = [];

        for (let i = 0; i < 16; i++) sockets.push(yield* openSocket(gateway.url));

        const request = () =>
          fetch(gateway.url.replace("ws:", "http:"), {
            headers: {
              upgrade: "websocket",
              connection: "Upgrade",
              "sec-websocket-version": "13",
              "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            },
          });

        expect((yield* Effect.promise(request)).status).toBe(503);
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              const socket = sockets[0]!;
              socket.onclose = () => resolve();
              socket.close();
            })
        );
        const replacement = yield* openSocket(gateway.url);
        expect(replacement.readyState).toBe(WebSocket.OPEN);
      })
    )
  ));

test.each(["message", "bytes"] as const)(
  "excessive %s closes input instead of retaining it",
  (kind) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gateway = yield* startGateway({ port: 0, recordPath: null });

          if (gateway === null) throw new Error("no gateway");
          yield* gateway.connections.pipe(
            Stream.runForEach((t) => Effect.sync(t.authenticated)),
            Effect.forkScoped
          );
          const socket = yield* openSocket(gateway.url);

          const closed = new Promise<number>((resolve) => {
            socket.onclose = (event) => resolve(event.code);
          });

          if (kind === "message") socket.send(new Uint8Array(MAX_FRAME_BYTES + 65));
          else {
            const chunk = new Uint8Array(MAX_FRAME_BYTES);

            for (let i = 0; i < 3; i++) socket.send(chunk);
          }

          const code = yield* Effect.promise(() => closed).pipe(Effect.timeout("2 seconds"));

          // Bun enforces the frame limit itself and closes with 1009.
          expect(code).toBe(1009);
        })
      )
    )
);

test("upgrade attempts are rate limited even when each connection immediately closes", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* startGateway({ port: 0, recordPath: null });

        if (gateway === null) throw new Error("no gateway");
        yield* gateway.connections.pipe(
          Stream.runForEach((t) => Effect.sync(t.authenticated)),
          Effect.forkScoped
        );
        // Invalid handshakes consume the same attempt budget without keeping sockets open.

        const responses = yield* Effect.promise(() =>
          Promise.all(
            Array.from({ length: 40 }, () =>
              fetch(gateway.url.replace("ws:", "http:"), { headers: { upgrade: "websocket" } })
            )
          )
        );

        expect(responses.some((response) => response.status === 429)).toBe(true);
      })
    )
  ));

test("the request budget refills with elapsed time without a recurring timer", () => {
  let now = 0;
  const take = requestBudget(2, 1, () => now);
  expect([take(), take(), take()]).toEqual([true, true, false]);
  now = 500;
  expect(take()).toBe(false);
  now = 1000;
  expect(take()).toBe(true);
  expect(take()).toBe(false);
  now = 100_000;
  expect([take(), take(), take()]).toEqual([true, true, false]);
});

test(
  "an unfinished chunked identity body has an absolute deadline",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gateway = yield* startGateway({ port: 0, recordPath: null });

          if (gateway === null) throw new Error("no gateway");

          const status = yield* Effect.promise(
            () =>
              new Promise<string>((resolve, reject) => {
                const socket = connect(gateway.port, "127.0.0.1", () =>
                  socket.write(
                    `POST /polaris/identity HTTP/1.1\r\nHost: 127.0.0.1:${gateway.port}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{\r\n`
                  )
                );

                const timeout = setTimeout(() => {
                  socket.destroy();
                  reject(new Error("body never expired"));
                }, 6500);

                socket.on("data", (bytes) => {
                  clearTimeout(timeout);
                  socket.destroy();
                  resolve(bytes.toString());
                });
                socket.on("error", (error) => {
                  clearTimeout(timeout);
                  reject(error);
                });
              })
          );

          expect(status).toContain("408");
        })
      )
    ),
  8000
);
