import { connectRpcWith, socketTransport } from "@polaris/client";
import { ExtensionDaemonRpcs, makeWire, PROTOCOL_VERSION } from "@polaris/protocol";
import { Effect, Layer, Predicate, Queue, Schema } from "effect";
import { join } from "node:path";
import { webSocketTransport } from "../gateway/client.testing.ts";
import { startServer } from "./server.ts";
import { scopedTempDir } from "../platform/tempDir.testing.ts";
import { TEST_USER_KEY } from "./userAccess.testing.ts";

const Reply = Schema.Struct({
  _tag: Schema.String,
  requestId: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
});

const Request = Schema.Struct({
  _tag: Schema.tag("Request"),
  id: Schema.Number,
  tag: Schema.String,
  payload: Schema.Record(Schema.String, Schema.Unknown),
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
});

export const Ack = Schema.Struct({ _tag: Schema.tag("Ack"), requestId: Schema.Number });

export const Interrupt = Schema.Struct({ _tag: Schema.tag("Interrupt"), requestId: Schema.Number });

export const admissionSetup = <R, E>(handlers: Layer.Layer<R, E>) =>
  Effect.gen(function* () {
    const root = yield* scopedTempDir("pl-rpc-cap-", { short: true });

    const server = yield* startServer({
      root,
      socketPath: join(root, "d.sock"),
      lockPath: join(root, "d.lock"),
      gateway: { port: 0 },
      handlers,
    });

    if (server.gateway === null) throw new Error("gateway did not bind");
    const url = server.gateway.url;

    const desktop = yield* Effect.flatMap(socketTransport(server.socketPath), (transport) =>
      connectRpcWith(ExtensionDaemonRpcs, transport)
    );

    yield* desktop.client.hello({
      clientName: "desktop",
      clientVersion: "0",
      deviceLabel: "test",
      capabilities: [],
      ...TEST_USER_KEY,
    });

    const pairing = yield* desktop.client["extensions.pair"]({
      name: "limits test",
      grant: ["read"],
    });

    const connect = (socket = false, token = true) =>
      Effect.gen(function* () {
        const transport = yield* socket
          ? socketTransport(server.socketPath)
          : webSocketTransport(url);

        const replies = yield* Queue.unbounded<typeof Reply.Type>();

        const wire = yield* makeWire(transport, (text) =>
          Queue.offer(replies, Schema.decodeUnknownSync(Schema.fromJsonString(Reply))(text)).pipe(
            Effect.asVoid
          )
        );

        const request = (
          id: number,
          tag = "harness.spinnerVerbs",
          payload: typeof Request.Type.payload = { cwd: null }
        ) =>
          wire.sendJson(
            JSON.stringify(
              Request.make({
                id,
                tag,
                payload,
                headers: [],
              })
            )
          );

        yield* request(0, "hello", {
          clientName: "flood-test",
          clientVersion: "0",
          deviceLabel: "test",
          capabilities: [],
          protocolVersions: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
          extensionToken: token ? pairing.token : undefined,
        });
        const hello = yield* Queue.take(replies);

        if (!Predicate.isTagged(hello, "Exit")) throw new Error("hello did not complete");

        return { wire, transport, request, replies };
      });

    return { desktop, connect };
  });
