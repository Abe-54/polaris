import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { connectRpc, socketTransport } from "@polaris/client";
import * as P from "@polaris/protocol";
import { Effect, Redacted, Schema, Logger, References, Deferred } from "effect";
import { Rpc } from "effect/rpc";
import {
  bindLanguageIdentity,
  languageIdentityFor,
  revokeLanguageIdentity,
} from "./languageIdentity.ts";
import { startServer } from "./server.ts";
import { ServerRpcs } from "./rpcs.ts";
import { CurrentLanguageConnection } from "./currentLanguageConnection.ts";
import { LanguageConnectionLifetime } from "./languageConnectionLifetime.ts";
import {
  replayIdentity,
  IdentityTrace,
} from "../../../../packages/spec/scripts/language-replay/identity.ts";
import { scopedTempDir } from "../platform/tempDir.testing.ts";

const first = Redacted.make("a".repeat(64));

const other = Redacted.make("b".repeat(64));

const hostId = P.HostId.make("host-a");

const hello = (languageProof?: Redacted.Redacted<unknown>) => {
  const payload = {
    clientName: "fake",
    clientVersion: "0",
    deviceLabel: "fixture",
    capabilities: [],
  };

  return languageProof === undefined ? payload : { ...payload, languageProof };
};

const temporary = scopedTempDir("pl-a0-socket-", { short: true });

const options = (root: string) => ({
  root,
  socketPath: join(root, "d.sock"),
  lockPath: join(root, "d.lock"),
});

test("first hello binds actual ServerClient, locks absent proof and revokes switching", () => {
  const connection = new Rpc.ServerClient(1);
  const identity = bindLanguageIdentity(connection, hostId, first);
  expect(identity).not.toBeNull();
  expect(bindLanguageIdentity(connection, hostId, first)).toEqual(identity);
  expect(() => bindLanguageIdentity(connection, hostId, other)).toThrow(
    "Language identity unavailable"
  );
  expect(languageIdentityFor(connection, hostId)).toBeNull();
  expect(() => bindLanguageIdentity(connection, hostId, first)).toThrow(
    "Language identity unavailable"
  );
  const oldPeer = new Rpc.ServerClient(2);
  expect(bindLanguageIdentity(oldPeer, hostId)).toBeNull();
  expect(() => bindLanguageIdentity(oldPeer, hostId, first)).toThrow(
    "Language identity unavailable"
  );
  expect(languageIdentityFor(new Rpc.ServerClient(1), hostId)).toBeNull();
});

test("public proof derivation is Host-bound and stable across independent reconnects", () => {
  const a = bindLanguageIdentity(new Rpc.ServerClient(1), hostId, first);
  const reconnect = bindLanguageIdentity(new Rpc.ServerClient(2), hostId, first);
  const hostB = bindLanguageIdentity(new Rpc.ServerClient(3), P.HostId.make("host-b"), first);
  const clientB = bindLanguageIdentity(new Rpc.ServerClient(4), hostId, other);
  expect(a).toEqual(reconnect);
  expect(hostB?.clientId === a?.clientId).toBe(false);
  expect(clientB?.clientId === a?.clientId).toBe(false);
  expect(JSON.stringify([a, reconnect, hostB, clientB]).includes(Redacted.value(first))).toBe(
    false
  );
});

test("authorized hello codec encodes proof but plain diagnostics stay redacted", () => {
  const input = hello(first);
  const encoded = Schema.encodeSync(P.Hello.payloadSchema)(input);
  expect(encoded.languageProof === Redacted.value(first)).toBe(true);
  expect(JSON.stringify(input).includes(Redacted.value(first))).toBe(false);
  expect(JSON.stringify(first)).toBe('"<redacted>"');
});

test("actual private Unix socket two Clients/two Hosts and reconnect negotiate only public identity", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const rootA = yield* temporary;
        const rootB = yield* temporary;
        const a = yield* startServer(options(rootA));
        const b = yield* startServer(options(rootB));
        const connectionA = yield* connectRpc(yield* socketTransport(a.socketPath));
        const connectionB = yield* connectRpc(yield* socketTransport(a.socketPath));
        const hostB = yield* connectRpc(yield* socketTransport(b.socketPath));
        const reconnect = yield* connectRpc(yield* socketTransport(a.socketPath));
        const old = yield* connectRpc(yield* socketTransport(a.socketPath));
        const initial = yield* connectionA.client.hello(hello(first));
        const repeated = yield* connectionA.client.hello(hello(first));
        const second = yield* connectionB.client.hello(hello(other));
        const remote = yield* hostB.client.hello(hello(first));
        const restored = yield* reconnect.client.hello(hello(first));
        const absent = yield* old.client.hello(hello());
        const refused = yield* Effect.flip(connectionA.client.hello(hello(other)));
        const oldSwitch = yield* Effect.flip(old.client.hello(hello(first)));

        return { initial, repeated, second, remote, restored, absent, refused, oldSwitch };
      })
    )
  );

  expect(result.initial.languageIdentity).toEqual(result.repeated.languageIdentity);
  expect(result.initial.languageIdentity).toEqual(result.restored.languageIdentity);
  expect(
    result.initial.languageIdentity?.clientId === result.second.languageIdentity?.clientId
  ).toBe(false);
  expect(
    result.initial.languageIdentity?.clientId === result.remote.languageIdentity?.clientId
  ).toBe(false);
  expect(result.absent.languageIdentity).toBeUndefined();
  expect(result.refused).toBeInstanceOf(P.LanguageIdentityError);
  expect(result.oldSwitch).toBeInstanceOf(P.LanguageIdentityError);
  expect(JSON.stringify(result).includes(Redacted.value(first))).toBe(false);
  expect(result.initial.capabilities).not.toContain("languages");
  const publicIdentity = (reply: typeof result.initial) => reply.languageIdentity ?? null;
  const host = result.initial.host.hostId;

  const trace = Schema.decodeUnknownSync(IdentityTrace)({
    format: "language-identity-v1",
    provenance: "runtime-fake-socket",
    events: [
      {
        connection: 0,
        hostId: host,
        action: "hello",
        offered: publicIdentity(result.initial),
        observed: publicIdentity(result.initial),
      },
      {
        connection: 0,
        hostId: host,
        action: "hello",
        offered: publicIdentity(result.repeated),
        observed: publicIdentity(result.repeated),
      },
      {
        connection: 1,
        hostId: host,
        action: "hello",
        offered: publicIdentity(result.second),
        observed: publicIdentity(result.second),
      },
      {
        connection: 2,
        hostId: result.remote.host.hostId,
        action: "hello",
        offered: publicIdentity(result.remote),
        observed: publicIdentity(result.remote),
      },
      {
        connection: 3,
        hostId: host,
        action: "hello",
        offered: publicIdentity(result.restored),
        observed: publicIdentity(result.restored),
      },
      { connection: 4, hostId: host, action: "hello", offered: null, observed: null },
      {
        connection: 0,
        hostId: host,
        action: "hello",
        offered: publicIdentity(result.second),
        observed: null,
      },
      {
        connection: 4,
        hostId: host,
        action: "hello",
        offered: publicIdentity(result.initial),
        observed: null,
      },
    ],
  });

  expect(() => replayIdentity(trace)).not.toThrow();
  expect(() =>
    replayIdentity({
      ...trace,
      events: [
        ...trace.events.slice(0, -1),
        { ...trace.events.at(-1)!, observed: publicIdentity(result.initial) },
      ],
    })
  ).toThrow("Identity trace observation mismatch");

  if (process.env.A0_TRACE_OUTPUT)
    writeFileSync(process.env.A0_TRACE_OUTPUT, JSON.stringify(trace));
});

test("malformed proof handler/schema failures never echo private values even with debug logging", async () => {
  const logs: string[] = [];
  const logger = Logger.make((entry) => logs.push(Logger.formatSimple.log(entry)));

  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporary;
        const server = yield* startServer(options(root));
        const rpc = yield* connectRpc(yield* socketTransport(server.socketPath));

        const error = yield* Effect.flip(
          rpc.client.hello(hello(Redacted.make({ secret: Redacted.value(first) })))
        );

        return error;
      })
    ).pipe(
      Effect.provide(Logger.layer([logger])),
      Effect.provideService(References.MinimumLogLevel, "All")
    )
  );

  expect(JSON.stringify(result).includes(Redacted.value(first))).toBe(false);
  expect(logs.join("\n").includes(Redacted.value(first))).toBe(false);
});

test("malformed hello sibling schema does not expose its private proof", async () => {
  const logs: string[] = [];
  const logger = Logger.make((entry) => logs.push(Logger.formatSimple.log(entry)));

  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporary;
        const server = yield* startServer(options(root));
        const response = yield* Deferred.make<string>();
        const transport = yield* socketTransport(server.socketPath);
        const wire = yield* P.makeWire(transport, (text) => Deferred.succeed(response, text));
        yield* wire.sendJson(
          JSON.stringify({
            // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Intentionally invalid encoded envelope audits the raw schema boundary.
            _tag: "Request",
            id: "1",
            tag: "hello",
            payload: { ...hello(), clientName: null, languageProof: Redacted.value(first) },
            headers: [],
          })
        );

        return yield* Deferred.await(response);
      })
    ).pipe(
      Effect.provide(Logger.layer([logger])),
      Effect.provideService(References.MinimumLogLevel, "All")
    )
  );

  expect(result.includes(Redacted.value(first))).toBe(false);
  expect(logs.join("\n").includes(Redacted.value(first))).toBe(false);
});

test("connection finalizer revokes retained authority without allowing rebinding", () => {
  const client = new Rpc.ServerClient(100);
  bindLanguageIdentity(client, hostId, first);
  revokeLanguageIdentity(client);
  expect(languageIdentityFor(client, hostId)).toBeNull();
  expect(() => bindLanguageIdentity(client, hostId, first)).toThrow(
    "Language identity unavailable"
  );
  expect(languageIdentityFor(new Rpc.ServerClient(100), hostId)).toBeNull();
});

test("actual socket finalizer revokes retained handler objects before disconnect cancellation", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporary;
        const entered = yield* Deferred.make<Rpc.ServerClient>();
        const finished = yield* Deferred.make<void>();
        let cleanupCalls = 0;
        let cleanupRevoked = false;

        const handlers = ServerRpcs.toLayerHandler("languages.catalog", (_input, { client }) =>
          Effect.gen(function* () {
            const authority = yield* CurrentLanguageConnection;
            const lifetime = yield* LanguageConnectionLifetime;
            const principal = authority.current();

            if (principal === null) return yield* Effect.die("missing fixture authority");
            yield* lifetime.attach(principal, () =>
              Effect.sync(() => {
                cleanupCalls++;
                cleanupRevoked = authority.current() === null;
              })
            );
            yield* Deferred.succeed(entered, client);

            return yield* Effect.never;
          }).pipe(Effect.ensuring(Deferred.succeed(finished, undefined)))
        );

        const server = yield* startServer({ ...options(root), handlers });
        const transport = yield* socketTransport(server.socketPath);
        const rpc = yield* connectRpc(transport);

        yield* rpc.client.hello(hello(first));
        yield* rpc.client["languages.catalog"]({}).pipe(Effect.ignore, Effect.forkScoped);
        const retained = yield* Deferred.await(entered);
        const before = languageIdentityFor(retained, server.hostInfo.hostId);

        yield* transport.close;
        yield* Deferred.await(finished);
        const after = languageIdentityFor(retained, server.hostInfo.hostId);
        let rebound = false;

        try {
          bindLanguageIdentity(retained, server.hostInfo.hostId, first);
          rebound = true;
        } catch {}

        return {
          before,
          after,
          rebound,
          reused: languageIdentityFor(new Rpc.ServerClient(retained.id), server.hostInfo.hostId),
          cleanupCalls,
          cleanupRevoked,
        };
      })
    )
  );

  expect(result.before).not.toBeNull();
  expect(result.after).toBeNull();
  expect(result.rebound).toBe(false);
  expect(result.reused).toBeNull();
  expect(result.cleanupCalls).toBe(1);
  expect(result.cleanupRevoked).toBe(true);
});

test("malformed raw JSON private proof never appears in debug parser diagnostics", async () => {
  const logs: string[] = [];
  let warning = () => {};

  const warned = new Promise<void>((resolve) => {
    warning = resolve;
  });

  const logger = Logger.make((entry) => {
    logs.push(Logger.formatSimple.log(entry));

    if (JSON.stringify(entry.message).includes("dropping an undecodable message")) warning();
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporary;
        const server = yield* startServer(options(root));
        const transport = yield* socketTransport(server.socketPath);
        const wire = yield* P.makeWire(transport, () => Effect.void);

        yield* wire.sendJson(`{"languageProof":"${Redacted.value(first)}",`);
        yield* Effect.promise(() => warned);
      })
    ).pipe(
      Effect.provide(Logger.layer([logger])),
      Effect.provideService(References.MinimumLogLevel, "All")
    )
  );

  expect(logs.some((entry) => entry.includes("dropping an undecodable message"))).toBe(true);
  expect(logs.some((entry) => entry.includes(Redacted.value(first)))).toBe(false);
  expect(logs.some((entry) => entry.includes("SyntaxError"))).toBe(false);
});
