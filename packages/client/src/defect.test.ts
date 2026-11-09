import { expect, test } from "bun:test";
import {
  type ByteTransport,
  type Capability,
  Hello,
  SessionId,
  HostId,
  HostInfo,
  makeWire,
  PROTOCOL_VERSION,
  type TransportError,
  type Wire,
} from "@polaris/protocol";
import {
  type Cause,
  Data,
  Effect,
  Exit,
  Fiber,
  Logger,
  Option,
  Predicate,
  Queue,
  Schema,
  type Scope,
  Stream,
} from "effect";
import { RpcSerialization } from "effect/rpc";
import { RpcClientError } from "effect/rpc/RpcClientError";
import {
  type ExitEncoded,
  type FromServerEncoded,
  ResponseDefectEncoded,
} from "effect/rpc/RpcMessage";
import { HostTarget, type LiveSession, makeHostConnection } from "./HostConnection.ts";
import { connectRpc, isDaemonDefect } from "./rpc.ts";
import { isCapabilityRefusal } from "./rpcGuard.ts";
import type { ClientTransport } from "./transport.ts";

/** The parts of a message from the Client that the fake Daemon looks at. */
const Sent = Schema.Struct({
  _tag: Schema.String,
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  tag: Schema.optional(Schema.String),
});

const decodeSent = Schema.decodeUnknownSync(Schema.fromJsonString(Sent));

const serialization = RpcSerialization.json.makeUnsafe();

const encodeJson = (message: FromServerEncoded): string => {
  const encoded = serialization.encode(message);

  if (!Predicate.isString(encoded)) throw new Error("the JSON serialization encodes to strings");

  return encoded;
};

const { Exit: ResponseExit, Pong } = Data.taggedEnum<FromServerEncoded>();

/** The frame a Daemon before ENG-313 sent when a handler died: no requestId, every request dropped. */
const connectionDefect = encodeJson(
  ResponseDefectEncoded(
    Schema.encodeSync(Schema.toCodecJson(Schema.Defect()))(new Error("listing /broken broke"))
  )
);

const { Success } = Data.taggedEnum<ExitEncoded<unknown, unknown>>();

const helloAnswer = (capabilities: ReadonlyArray<Capability>) =>
  Success({
    value: Schema.encodeSync(Schema.toCodecJson(Hello.successSchema))({
      host: new HostInfo({
        hostId: HostId.make("old-host"),
        hostname: "old",
        platform: "linux-x64",
        daemonVersion: "0.1.0",
        homeDir: "/home/old",
        startedAt: "2026-10-01T00:00:00.000Z",
      }),
      protocolVersion: PROTOCOL_VERSION,
      capabilities,
    }),
  });

/** The fake Daemon's answer to each RPC it serves besides `hello`. */
const answers = new Map<string, ExitEncoded<unknown, unknown>>([
  ["harness.spinnerVerbs", Success({ value: null })],
]);

type Pipe = Queue.Queue<Uint8Array, TransportError | Cause.Done>;

interface FakeConnection {
  readonly peer: Wire;
  readonly received: Array<typeof Sent.Type>;
  readonly pings: () => number;
}

/**
 * One connection to a fake older Daemon, through the protocol's Wire: it answers `hello` and
 * pings, holds `harness.spinnerVerbs` while `hold` is set, and answers it with null otherwise.
 * Any other request tag gets the connection-level Defect an older Daemon sends for one it doesn't know.
 */
const fakeDaemon = (
  hold: boolean,
  capabilities: ReadonlyArray<Capability> = ["harness.spinner-verbs"]
) =>
  Effect.gen(function* () {
    const toPeer: Pipe = yield* Queue.unbounded<Uint8Array, TransportError | Cause.Done>();
    const toClient: Pipe = yield* Queue.unbounded<Uint8Array, TransportError | Cause.Done>();

    const side = (inbox: Pipe, outbox: Pipe): ByteTransport => ({
      incoming: Stream.fromQueue(inbox),
      write: (bytes) => Effect.sync(() => Queue.offerUnsafe(outbox, bytes)),
      close: Effect.sync(() => Queue.endUnsafe(outbox)),
    });

    const received: Array<typeof Sent.Type> = [];

    const answer = (peer: Wire, message: typeof Sent.Type) => {
      if (Predicate.isTagged(message, "Ping")) return peer.sendJson(encodeJson(Pong()));

      if (message.tag === "hello" && message.id !== undefined)
        return peer.sendJson(
          encodeJson(ResponseExit({ requestId: message.id, exit: helloAnswer(capabilities) }))
        );
      const exit = message.tag === undefined ? undefined : answers.get(message.tag);

      if (message.id !== undefined && message.tag !== undefined && exit === undefined)
        return peer.sendJson(connectionDefect);

      if (message.id === undefined || exit === undefined || hold) return Effect.void;

      return peer.sendJson(encodeJson(ResponseExit({ requestId: message.id, exit })));
    };

    const peer: Wire = yield* makeWire(side(toPeer, toClient), (text) =>
      Effect.suspend(() => {
        const message = decodeSent(text);
        received.push(message);

        return Effect.ignore(answer(peer, message));
      })
    );

    const transport: ClientTransport = {
      ...side(toClient, toPeer),
      diagnose: Effect.die("unused"),
    };

    const pings = () => received.filter(Predicate.isTagged("Ping")).length;

    return { transport, connection: { peer, received, pings } satisfies FakeConnection };
  });

const waitFor = (condition: () => boolean) =>
  Effect.gen(function* () {
    for (let waited = 0; !condition() && waited < 2000; waited += 5) yield* Effect.sleep(5);
  });

const withLogs = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => {
  const logs: Array<string> = [];
  const logger = Logger.make((entry) => logs.push(Logger.formatSimple.log(entry)));

  return Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(Logger.layer([logger])))).then(
    (result) => ({ result, logs })
  );
};

const verbs = { cwd: null };

const dropped = "the Daemon dropped every request on this connection after a defect";

test("an older Daemon's connection-level defect fails the connection, its requests, and stops the pings", async () => {
  const { result, logs } = await withLogs(
    Effect.gen(function* () {
      const { transport, connection: daemon } = yield* fakeDaemon(true);
      const rpc = yield* connectRpc(transport, { pingIntervalMs: 20 });

      const inFlight = yield* rpc.client["harness.spinnerVerbs"](verbs).pipe(
        Effect.exit,
        Effect.forkScoped
      );

      yield* waitFor(() => daemon.pings() > 0);
      yield* daemon.peer.sendJson(connectionDefect);

      const lost = yield* rpc.lost.pipe(Effect.flip, Effect.timeout(1000));
      const failed = yield* Fiber.join(inFlight);

      const after = yield* rpc.client["harness.spinnerVerbs"](verbs).pipe(
        Effect.exit,
        Effect.timeout(1000)
      );

      // Let a ping already on the wire land before counting.
      yield* Effect.sleep(30);
      const pingsAtLoss = daemon.pings();
      yield* Effect.sleep(120);

      return { lost, failed, after, pingsAtLoss, pingsLater: daemon.pings() };
    })
  );

  const messages = [result.failed, result.after].map((exit) =>
    Exit.isFailure(exit) ? String(Exit.findErrorOption(exit)) : "succeeded"
  );

  expect(isDaemonDefect(result.lost)).toBe(true);
  expect(result.lost.message).toContain("listing /broken broke");
  expect(messages.every((message) => message.includes(dropped))).toBe(true);
  expect(result.pingsLater).toBe(result.pingsAtLoss);
  expect(logs.filter((line) => line.includes(dropped))).toHaveLength(1);
});

test("a HostConnection to an older Daemon reconnects after its defect, and a request then succeeds", async () => {
  const { result, logs } = await withLogs(
    Effect.gen(function* () {
      const daemons: Array<FakeConnection> = [];

      const host = yield* makeHostConnection({
        key: "old",
        name: "old",
        target: HostTarget.Local({ socketPath: "/unused" }),
        identity: { name: "t", version: "0", deviceLabel: "t", capabilities: [] },
        connector: Effect.suspend(() =>
          Effect.map(fakeDaemon(daemons.length === 0), ({ transport, connection }) => {
            daemons.push(connection);

            return transport;
          })
        ),
        rpc: { pingIntervalMs: 20 },
      });

      const failures: Array<string> = [];

      yield* host.changes.pipe(
        Stream.runForEach((s) =>
          Effect.sync(() => {
            if (s.state === "reconnecting" && s.failure !== null)
              failures.push(`${s.failure.reason}: ${s.failure.detail}`);
          })
        ),
        Effect.forkScoped
      );

      const first = yield* host.awaitSession;

      const inFlight = yield* first.client["harness.spinnerVerbs"](verbs).pipe(
        Effect.exit,
        Effect.forkScoped
      );

      yield* waitFor(() => daemons[0]!.received.some((m) => m.tag === "harness.spinnerVerbs"));
      yield* daemons[0]!.peer.sendJson(connectionDefect);
      const failed = yield* Fiber.join(inFlight);

      const session = yield* (host.sessionChanges ?? Stream.empty).pipe(
        Stream.filter((s): s is LiveSession => s !== null && s.epoch > first.epoch),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
        Effect.timeout(2000)
      );

      const answered = yield* session.client["harness.spinnerVerbs"](verbs).pipe(
        Effect.timeout(1000)
      );

      return { failed, failures, answered, connections: daemons.length };
    })
  );

  expect(Exit.isFailure(result.failed)).toBe(true);
  expect(result.connections).toBe(2);
  expect(result.answered).toBeNull();
  expect(result.failures).toEqual([`connection-lost: ${dropped} (Error: listing /broken broke)`]);
  expect(logs.filter((line) => line.includes(dropped))).toHaveLength(1);
});

test("a HostConnection never sends an older Daemon an RPC its hello didn't announce, and stays connected", async () => {
  const { result } = await withLogs(
    Effect.gen(function* () {
      const daemons: Array<FakeConnection> = [];

      const host = yield* makeHostConnection({
        key: "old",
        name: "old",
        target: HostTarget.Local({ socketPath: "/unused" }),
        identity: {
          name: "t",
          version: "0",
          deviceLabel: "t",
          capabilities: ["harness.spinner-verbs", "data", "git.log"],
        },
        connector: Effect.suspend(() =>
          Effect.map(fakeDaemon(false), ({ transport, connection }) => {
            daemons.push(connection);

            return transport;
          })
        ),
        rpc: { pingIntervalMs: 20 },
      });

      const session = yield* host.awaitSession;

      const call = yield* session.client["git.log"]({ cwd: "/repo", limit: 5 }).pipe(Effect.flip);

      const stream = yield* session.client["data.sources.watch"]({
        sessionId: SessionId.make("s"),
      }).pipe(Stream.runDrain, Effect.flip);

      const answered = yield* session.client["harness.spinnerVerbs"](verbs).pipe(
        Effect.timeout(1000)
      );

      return {
        refused: [call, stream].map((error) =>
          error instanceof RpcClientError ? [isCapabilityRefusal(error), error.message] : error
        ),
        tags: daemons.flatMap((daemon) => daemon.received.flatMap((m) => m.tag ?? [])),
        connections: daemons.length,
        answered,
      };
    })
  );

  expect(result.refused).toEqual([
    [true, "RpcClientDefect: the Daemon doesn't announce git.log"],
    [true, "RpcClientDefect: the Daemon doesn't announce data"],
  ]);
  expect(result.tags).not.toContain("git.log");
  expect(result.tags).not.toContain("data.sources.watch");
  expect(result.answered).toBeNull();
  expect(result.connections).toBe(1);
});
