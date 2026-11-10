import { localEndpoint } from "@polaris/protocol/endpoint";
/**
 * The gateway end to end (ENG-399): the Daemon's `ServerRpcs` over a real
 * WebSocket on loopback. A token-less hello and any request before hello are
 * refused and the connection closed; a protocol range is required and a
 * mismatch says which side to update; a paired Extension reaches handlers as
 * itself; browsers are kept out at the upgrade; revoking cuts the connection.
 */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { connectRpcWith, socketTransport } from "@polaris/client";
import {
  Command,
  CommandId,
  CommandRejected,
  ExtensionDaemonRpcs,
  ExtensionTokenRejected,
  NotGranted,
  PROTOCOL_VERSION,
  ProtocolMismatch,
  SessionId,
  VoiceError,
  VoiceTranscript,
} from "@polaris/protocol";
import { Context, Effect, Exit, Layer, Predicate, Redacted, Stream } from "effect";
import { BlobChannel } from "../services.ts";
import { DeviceLabel } from "../engine/rpc.ts";
import { actorOf } from "../extensions/connection.ts";
import { ServerRpcs } from "../transport/rpcs.ts";
import { startServer } from "../transport/server.ts";
import { webSocketTransport } from "./client.testing.ts";
import { readGatewayRecord } from "./config.ts";
import { CLOSE_GOING_AWAY } from "./transport.ts";
import { newTempDir, removeTempDirSettled, scopedTempDir } from "../platform/tempDir.testing.ts";
import { TEST_USER_KEY } from "../transport/userAccess.testing.ts";

const temporary = scopedTempDir("pl-gw-", { short: true });

/** `dispatch` answers with who asked, to prove the connection's identity reached a handler. */
const handlers = Layer.mergeAll(
  ServerRpcs.toLayerHandler("voice.transcribe", ({ audio }) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const blobs = yield* BlobChannel;

        const bytes = yield* blobs
          .take(audio)
          .pipe(
            Effect.mapError(
              (error) => new VoiceError({ reason: "audio-failed", message: error.message })
            )
          );

        return Stream.succeed(
          new VoiceTranscript({
            finalText: String(bytes.byteLength),
            interimText: "",
            finished: true,
          })
        );
      })
    )
  ),
  ServerRpcs.toLayerHandler("dispatch", ({ commandId }, { client }) =>
    Effect.fail(
      new CommandRejected({
        commandId,
        reason: `${Context.getOrUndefined(client.annotations, DeviceLabel)}:${actorOf(client)._tag}`,
      })
    )
  )
);

const identity = {
  clientName: "sdk-test",
  clientVersion: "0",
  deviceLabel: "Raycast on a Mac",
  capabilities: [],
};

const range = { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION };

const hello = (token: string | null, protocolVersions?: { min: number; max: number }) => {
  const withToken =
    token === null ? identity : { ...identity, extensionToken: Redacted.make(token) };

  return protocolVersions === undefined ? withToken : { ...withToken, protocolVersions };
};

const sendTurn = Command.cases.SendTurn.make({
  sessionId: SessionId.make("s1"),
  prompt: "hi",
  attachments: [],
});

const setup = Effect.gen(function* () {
  const root = yield* temporary;

  const server = yield* startServer({
    root,
    socketPath: localEndpoint(root),
    lockPath: join(root, "d.lock"),
    handlers,
    gateway: { port: 0 },
  });

  if (server.gateway === null) throw new Error("the gateway did not bind an ephemeral port");
  const url = server.gateway.url;

  const overWebSocket = (options: { origin?: string } = {}) =>
    Effect.flatMap(webSocketTransport(url, options), (transport) =>
      Effect.map(connectRpcWith(ExtensionDaemonRpcs, transport), (rpc) => ({ ...rpc, transport }))
    );

  const desktop = yield* Effect.flatMap(socketTransport(server.socketPath), (transport) =>
    connectRpcWith(ExtensionDaemonRpcs, transport)
  );

  yield* desktop.client.hello({ ...hello(null), ...TEST_USER_KEY });

  return { root, server, url, overWebSocket, desktop };
});

test("a gateway connection must present a token and a protocol range in hello, before anything", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { overWebSocket, desktop } = yield* setup;

        const paired = yield* desktop.client["extensions.pair"]({
          name: "Raycast",
          grant: ["read", "turn"],
        });

        const tokenless = yield* overWebSocket();
        expect(yield* Effect.flip(tokenless.client.hello(hello(null, range)))).toEqual(
          new ExtensionTokenRejected({ reason: "missing" })
        );
        yield* Effect.flip(tokenless.lost).pipe(Effect.timeout("2 seconds"));

        const early = yield* overWebSocket();
        const refused = yield* Effect.flip(early.client["extensions.list"]());
        expect(
          Predicate.isTagged(refused, "NotGranted") || Predicate.isTagged(refused, "RpcClientError")
        ).toBe(true);
        yield* Effect.flip(early.lost).pipe(Effect.timeout("2 seconds"));

        const silent = yield* overWebSocket();
        expect(yield* Effect.flip(silent.client.hello(hello(paired.token)))).toEqual(
          new ProtocolMismatch({ daemon: PROTOCOL_VERSION, extension: null, update: "extension" })
        );

        const newer = yield* Effect.flip(
          silent.client.hello(
            hello(paired.token, { min: PROTOCOL_VERSION + 1, max: PROTOCOL_VERSION + 2 })
          )
        );

        expect(Predicate.isTagged(newer, "ProtocolMismatch") && newer.update).toBe("polaris");
        expect(newer.message).toContain("Update Polaris");

        const older = yield* Effect.flip(
          silent.client.hello(hello(paired.token, { min: 0, max: PROTOCOL_VERSION - 1 }))
        );

        expect(Predicate.isTagged(older, "ProtocolMismatch") && older.update).toBe("extension");
        expect(older.message).toContain("Update the Extension");

        // A valid token alone must not authorize RPCs after a refused version.
        expect(yield* Effect.flip(silent.client["harness.spinnerVerbs"]({ cwd: null }))).toEqual(
          new NotGranted({ what: "harness.spinnerVerbs", needed: null })
        );

        // The same connection may then say a range it speaks.
        yield* silent.client.hello(hello(paired.token, range));

        const asked = yield* Effect.flip(
          silent.client.dispatch({ commandId: CommandId.make("c1"), command: sendTurn })
        );

        expect(asked).toEqual(
          new CommandRejected({ commandId: CommandId.make("c1"), reason: "Raycast:Extension" })
        );
      })
    )
  );
});

test("a paired Extension over the gateway gets its Grant, nothing kept for Clients, and is cut off by revoke", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { overWebSocket, desktop, root, server } = yield* setup;
        const record = readGatewayRecord(join(root, "gateway.json"));
        expect(record).toEqual({
          port: server.gateway?.port ?? -1,
          secret: server.gateway?.secret ?? "",
        });

        const glasses = yield* desktop.client["extensions.pair"]({ name: "G2", grant: ["read"] });

        // The Even app's WebView: an Origin of 127.0.0.1 with a port that changes every launch.
        const ext = yield* overWebSocket({ origin: "http://127.0.0.1:55660" });
        yield* ext.client.hello(hello(glasses.token, range));

        const turn = yield* Effect.flip(
          ext.client.dispatch({ commandId: CommandId.make("c2"), command: sendTurn })
        );

        expect(turn).toEqual(new NotGranted({ what: "dispatch:SendTurn", needed: "turn" }));
        expect(yield* Effect.flip(ext.client["extensions.list"]())).toEqual(
          new NotGranted({ what: "extensions.list", needed: null })
        );
        expect(yield* Effect.flip(ext.client["extensions.pair"]({ name: "x", grant: [] }))).toEqual(
          new NotGranted({ what: "extensions.pair", needed: null })
        );
        expect(yield* ext.client["harness.spinnerVerbs"]({ cwd: null })).toBeNull();
        expect(server.connections()).toBe(2);

        yield* desktop.client["extensions.revoke"]({ id: glasses.pairing.id });
        yield* Effect.flip(ext.lost).pipe(Effect.timeout("2 seconds"));
        expect((yield* ext.transport.closed).code).toBe(1000);

        const again = yield* overWebSocket();
        expect(yield* Effect.flip(again.client.hello(hello(glasses.token, range)))).toEqual(
          new ExtensionTokenRejected({ reason: "revoked" })
        );
      })
    )
  );
});

test("the Daemon stopping closes gateway connections as going away and removes gateway.json", async () => {
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const root = newTempDir("pl-gw-stop-", { short: true });

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* startServer({
            root,
            socketPath: localEndpoint(root),
            lockPath: join(root, "d.lock"),
            handlers,
            gateway: { port: 0 },
          });

          if (server.gateway === null) throw new Error("no gateway");

          // Not `webSocketTransport`: its release would close the socket (1000) before the server.
          const { closed } = yield* Effect.promise(
            () =>
              new Promise<{ closed: Promise<number> }>((connected) => {
                const socket = new WebSocket(server.gateway?.url ?? "");

                const code = new Promise<number>((resolve) => {
                  socket.onclose = (event) => resolve(event.code);
                });

                // Boxed: a promise resolved with a promise would wait for the close itself.
                socket.onopen = () => connected({ closed: code });
              })
          );

          return { closed: Effect.promise(() => closed), record: join(root, "gateway.json") };
        })
      );

      const code = yield* result.closed;
      const recordLeft = existsSync(result.record);
      yield* Effect.promise(() => removeTempDirSettled(root));

      return { code, recordLeft };
    })
  );

  expect(outcome).toEqual({ code: CLOSE_GOING_AWAY, recordLeft: false });
});

/** An HTTP request written by hand, so the Host header can be anything. */
const rawRequest = (port: number, lines: ReadonlyArray<string>) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve, reject) => {
        let response = "";

        void Bun.connect({
          hostname: "127.0.0.1",
          port,
          socket: {
            open(socket) {
              socket.write(`${lines.join("\r\n")}\r\n\r\n`);
            },
            data(socket, data) {
              response += data.toString();

              if (response.includes("\r\n\r\n")) socket.end();
            },
            close() {
              resolve(response.split("\r\n")[0] ?? "");
            },
            error(_socket, error) {
              reject(error);
            },
          },
        });
      })
  );

const upgradeLines = (host: string, origin?: string) => [
  "GET /polaris/rpc HTTP/1.1",
  `Host: ${host}`,
  "Connection: Upgrade",
  "Upgrade: websocket",
  "Sec-WebSocket-Version: 13",
  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
  ...(origin === undefined ? [] : [`Origin: ${origin}`]),
];

test("browsers are refused at the upgrade: foreign Host or Origin, other paths and methods", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { server, url, overWebSocket } = yield* setup;
        const port = server.gateway?.port ?? 0;
        const http = url.replace("ws://", "http://");

        const status = (response: Response) => response.status;

        expect(status(yield* Effect.promise(() => fetch(http)))).toBe(426);
        expect(status(yield* Effect.promise(() => fetch(`${http}/other`)))).toBe(404);
        expect(status(yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/`)))).toBe(404);
        expect(status(yield* Effect.promise(() => fetch(http, { method: "POST" })))).toBe(405);
        expect(
          status(
            yield* Effect.promise(() =>
              fetch(http, { headers: { origin: "https://evil.example" } })
            )
          )
        ).toBe(403);
        expect(
          status(
            yield* Effect.promise(() =>
              fetch(http, { headers: { origin: "http://127.0.0.1:55660" } })
            )
          )
        ).toBe(426);

        expect(yield* rawRequest(port, upgradeLines("evil.example"))).toContain("403");
        expect(yield* rawRequest(port, upgradeLines("127.0.0.1.nip.io:7477"))).toContain("403");
        expect(yield* rawRequest(port, upgradeLines("studio.tail1234.ts.net"))).toContain("101");
        expect(yield* rawRequest(port, upgradeLines(`localhost:${port}`))).toContain("101");
        expect(
          yield* rawRequest(port, upgradeLines(`127.0.0.1:${port}`, "https://evil.example"))
        ).toContain("403");

        const refused = yield* Effect.exit(overWebSocket({ origin: "https://evil.example" }));
        expect(Exit.isFailure(refused)).toBe(true);
        const browserless = yield* Effect.exit(overWebSocket());
        expect(Exit.isSuccess(browserless)).toBe(true);
      })
    )
  );
});

test(
  "an incomplete hello expires but an authenticated idle Extension stays connected",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { overWebSocket, desktop, url } = yield* setup;

          const paired = yield* desktop.client["extensions.pair"]({
            name: "idle",
            grant: ["read"],
          });

          const ext = yield* overWebSocket();
          yield* ext.client.hello(hello(paired.token, range));

          const closed = yield* Effect.promise(
            () =>
              new Promise<number>((resolve) => {
                const socket = new WebSocket(url);
                socket.onopen = () => socket.send(new Uint8Array([0]));
                socket.onclose = (event) => resolve(event.code);
              })
          ).pipe(Effect.timeout("12 seconds"));

          expect(closed).toBe(1008);
          expect(yield* ext.client["harness.spinnerVerbs"]({ cwd: null })).toBeNull();
        })
      )
    ),
  15000
);

test("gateway Wire accepts a five-minute voice blob but refuses a blob over its limit", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { overWebSocket, desktop } = yield* setup;

        const paired = yield* desktop.client["extensions.pair"]({
          name: "voice",
          grant: ["voice"],
        });

        const ext = yield* overWebSocket();
        yield* ext.client.hello(hello(paired.token, range));
        const audio = yield* ext.blobs.offer(new Uint8Array(9_600_000));
        const transcript = yield* ext.client["voice.transcribe"]({ audio }).pipe(Stream.runCollect);
        expect(transcript.map((item) => item.finalText)).toEqual(["9600000"]);
        const excessive = yield* ext.blobs.offer(new Uint8Array(17 * 1024 * 1024));

        const error = yield* ext.client["voice.transcribe"]({ audio: excessive }).pipe(
          Stream.runDrain,
          Effect.flip
        );

        expect(Predicate.isTagged(error, "VoiceError") && error.reason).toBe("audio-failed");
      })
    )
  ));

test("pre-hello binary input has a cumulative byte budget even as the Wire drains it", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { url } = yield* setup;

        const code = yield* Effect.promise(
          () =>
            new Promise<number>((resolve) => {
              const socket = new WebSocket(url);
              socket.onopen = () => socket.send(new Uint8Array(65 * 1024));
              socket.onclose = (event) => resolve(event.code);
            })
        ).pipe(Effect.timeout("2 seconds"));

        expect(code).toBe(1009);
      })
    )
  ));
