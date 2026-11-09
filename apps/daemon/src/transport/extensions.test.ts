/**
 * Pairings and Grants over a real socket (ENG-398): a token-less Client pairs,
 * an Extension is scoped to the Pairing's Grant and refused the rest, a bad
 * token fails hello, and revoking cuts the Extension off. Every observation
 * is replayed against the spec's reference, and written as a trace for
 * `scripts/replay-extensions.ts` when `EXTENSIONS_TRACE_OUTPUT` is set.
 */
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { connectRpcWith, socketTransport } from "@polaris/client";
import {
  Command,
  CommandId,
  CommandRejected,
  decodePairingString,
  ExtensionDaemonRpcs,
  ExtensionTokenRejected,
  HostStreamItem,
  NotFound,
  NotGranted,
  PairingId,
  Sequence,
  SessionId,
} from "@polaris/protocol";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Option,
  Predicate,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { DeviceLabel } from "../engine/rpc.ts";
import { actorOf } from "../extensions/connection.ts";
import { ServerRpcs } from "./rpcs.ts";
import { startServer } from "./server.ts";
import {
  decodeExtensionsTrace,
  ExtensionsTraceEvent,
  replayExtensions,
} from "../../../../packages/spec/scripts/extensions-replay/index.ts";
import { scopedTempDir } from "../platform/tempDir.testing.ts";
import { TEST_USER_KEY } from "./userAccess.testing.ts";

const temporary = scopedTempDir("pl-ext-", { short: true });

/** `dispatch` answers with who asked, to prove the annotations reached a handler. */
const handlers = Layer.mergeAll(
  ServerRpcs.toLayerHandler("dispatch", ({ commandId }, { client }) =>
    Effect.fail(
      new CommandRejected({
        commandId,
        reason: `${Context.getOrUndefined(client.annotations, DeviceLabel)}:${actorOf(client)._tag}`,
      })
    )
  ),
  ServerRpcs.toLayerHandler("subscribeHost", () =>
    Stream.concat(
      Stream.fromIterable([
        HostStreamItem.cases.Snapshot.make({
          sequence: Sequence.make(0),
          workspaces: [],
          worktrees: [],
          sessions: [],
          reviewCheckouts: [],
        }),
      ]),
      Stream.never
    )
  )
);

const identity = {
  clientName: "test",
  clientVersion: "0",
  deviceLabel: "Test MacBook",
  capabilities: [],
};

const hello = (token?: string) =>
  token === undefined ? identity : { ...identity, extensionToken: Redacted.make(token) };

const readHosts = { path: "/etc/hosts", offset: null, length: null };

const sendTurn = Command.cases.SendTurn.make({
  sessionId: SessionId.make("s1"),
  prompt: "hi",
  attachments: [],
});

/** A gated call's outcome as the trace records it: refused by the gate, or the connection gone. */
const isNotGranted = Schema.is(NotGranted);

const observedOf = (error: { readonly _tag: string }): string =>
  Match.value(error).pipe(
    Match.when(isNotGranted, (e) =>
      e.needed === null ? "not-for-extensions" : `refused:${e.needed}`
    ),
    Match.orElse(() => "dropped")
  );

test("an Extension gets its Grant and nothing more, and revoking cuts it off", async () => {
  const trace: Array<ExtensionsTraceEvent> = [];
  const record = (event: ExtensionsTraceEvent) => trace.push(event);

  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporary;

        const server = yield* startServer({
          root,
          socketPath: join(root, "d.sock"),
          lockPath: join(root, "d.lock"),
          handlers,
        });

        const connect = () =>
          Effect.flatMap(socketTransport(server.socketPath), (transport) =>
            connectRpcWith(ExtensionDaemonRpcs, transport)
          );

        const desktop = yield* connect();
        yield* desktop.client.hello({ ...hello(), ...TEST_USER_KEY });
        record(
          ExtensionsTraceEvent.cases.Hello.make({ connection: 0, pairing: null, observed: "ok" })
        );
        expect(yield* desktop.client["extensions.list"]()).toEqual([]);
        record(
          ExtensionsTraceEvent.cases.Call.make({
            connection: 0,
            need: "client",
            observed: "allowed",
          })
        );

        const raycast = yield* desktop.client["extensions.pair"]({
          name: "Raycast",
          grant: ["read"],
        });

        record(ExtensionsTraceEvent.cases.Pair.make({ pairing: 0, grant: ["read"] }));
        expect(raycast.token).toMatch(/^pol_ext_/);
        expect(JSON.stringify(raycast.pairing)).not.toContain(raycast.token);

        // The Extension: read is allowed, a Turn and anything kept for Clients is refused.
        const ext = yield* connect();
        yield* ext.client.hello(hello(raycast.token));
        record(
          ExtensionsTraceEvent.cases.Hello.make({ connection: 1, pairing: 0, observed: "ok" })
        );
        const snapshot = yield* Deferred.make<HostStreamItem>();

        const feed = yield* ext.client.subscribeHost({ afterSequence: null }).pipe(
          Stream.tap((item) => Deferred.succeed(snapshot, item)),
          Stream.runDrain,
          Effect.exit,
          Effect.forkScoped
        );

        expect(Predicate.isTagged(yield* Deferred.await(snapshot), "Snapshot")).toBe(true);
        record(
          ExtensionsTraceEvent.cases.Call.make({ connection: 1, need: "read", observed: "allowed" })
        );

        const turn = yield* Effect.flip(
          ext.client.dispatch({ commandId: CommandId.make("c1"), command: sendTurn })
        );

        expect(turn).toEqual(new NotGranted({ what: "dispatch:SendTurn", needed: "turn" }));
        record(
          ExtensionsTraceEvent.cases.Call.make({
            connection: 1,
            need: "turn",
            observed: observedOf(turn),
          })
        );
        const file = yield* Effect.flip(ext.client["files.read"](readHosts));
        expect(file).toEqual(new NotGranted({ what: "files.read", needed: null }));
        record(
          ExtensionsTraceEvent.cases.Call.make({
            connection: 1,
            need: "client",
            observed: observedOf(file),
          })
        );
        const list = yield* Effect.flip(ext.client["extensions.list"]());
        expect(list).toEqual(new NotGranted({ what: "extensions.list", needed: null }));
        record(
          ExtensionsTraceEvent.cases.Call.make({
            connection: 1,
            need: "client",
            observed: observedOf(list),
          })
        );

        // A later token-less hello neither widens nor drops the scope.
        yield* ext.client.hello(hello());
        record(
          ExtensionsTraceEvent.cases.Hello.make({ connection: 1, pairing: null, observed: "ok" })
        );
        const still = yield* Effect.flip(ext.client["files.read"](readHosts));
        record(
          ExtensionsTraceEvent.cases.Call.make({
            connection: 1,
            need: "client",
            observed: observedOf(still),
          })
        );

        // A malformed or never issued token fails hello.
        const stranger = yield* connect();
        const malformed = yield* Effect.flip(stranger.client.hello(hello("pol_ext_nope")));
        expect(malformed).toEqual(new ExtensionTokenRejected({ reason: "malformed" }));
        record(
          ExtensionsTraceEvent.cases.Hello.make({ connection: 2, pairing: 5, observed: "refused" })
        );
        const strangerCall = yield* Effect.flip(stranger.client["extensions.list"]());
        record(
          ExtensionsTraceEvent.cases.Call.make({
            connection: 2,
            need: "client",
            observed: observedOf(strangerCall),
          })
        );
        const stranger2 = yield* connect();

        const unknown = yield* Effect.flip(
          stranger2.client.hello(hello(`pol_ext_${"A".repeat(43)}`))
        );

        expect(unknown).toEqual(new ExtensionTokenRejected({ reason: "unknown" }));
        record(
          ExtensionsTraceEvent.cases.Hello.make({ connection: 5, pairing: 6, observed: "refused" })
        );

        // An Extension with the turn Grant reaches dispatch as itself, by name.
        const glasses = yield* desktop.client["extensions.pair"]({
          name: "G2",
          grant: ["turn", "read"],
        });

        record(ExtensionsTraceEvent.cases.Pair.make({ pairing: 1, grant: ["read", "turn"] }));
        const ext2 = yield* connect();
        yield* ext2.client.hello(hello(glasses.token));
        record(
          ExtensionsTraceEvent.cases.Hello.make({ connection: 3, pairing: 1, observed: "ok" })
        );

        // A later token-less hello neither widens the connection nor relabels it.
        yield* ext2.client.hello(hello());

        const asked = yield* Effect.flip(
          ext2.client.dispatch({ commandId: CommandId.make("c2"), command: sendTurn })
        );

        expect(asked).toEqual(
          new CommandRejected({ commandId: CommandId.make("c2"), reason: "G2:Extension" })
        );
        record(
          ExtensionsTraceEvent.cases.Call.make({ connection: 3, need: "turn", observed: "allowed" })
        );

        const fromDesktop = yield* Effect.flip(
          desktop.client.dispatch({ commandId: CommandId.make("c3"), command: sendTurn })
        );

        expect(fromDesktop).toMatchObject({ reason: "Test MacBook:Client" });
        record(
          ExtensionsTraceEvent.cases.Call.make({ connection: 0, need: "turn", observed: "allowed" })
        );

        const listed = yield* desktop.client["extensions.list"]();
        expect(listed.map((p) => [p.name, p.lastUsedAt !== null, p.revokedAt])).toEqual([
          ["Raycast", true, null],
          ["G2", true, null],
        ]);

        // Revoking closes the Extension's connection and refuses its token from then on.
        const revoked = yield* desktop.client["extensions.revoke"]({ id: raycast.pairing.id });
        record(ExtensionsTraceEvent.cases.Revoke.make({ pairing: 0, observed: "ok" }));
        expect(revoked.revokedAt).not.toBeNull();
        const ended = yield* Fiber.join(feed);
        expect(Exit.isFailure(ended)).toBe(true);
        yield* Effect.flip(ext.lost);
        const dropped = yield* Effect.flip(ext.client["files.read"](readHosts));
        expect(Predicate.isTagged(dropped, "RpcClientError")).toBe(true);
        record(
          ExtensionsTraceEvent.cases.Call.make({
            connection: 1,
            need: "client",
            observed: observedOf(dropped),
          })
        );
        const again = yield* connect();
        const refused = yield* Effect.flip(again.client.hello(hello(raycast.token)));
        expect(refused).toEqual(new ExtensionTokenRejected({ reason: "revoked" }));
        record(
          ExtensionsTraceEvent.cases.Hello.make({ connection: 4, pairing: 0, observed: "refused" })
        );
        const twice = yield* desktop.client["extensions.revoke"]({ id: raycast.pairing.id });
        expect(twice.revokedAt).toBe(revoked.revokedAt);
        record(ExtensionsTraceEvent.cases.Revoke.make({ pairing: 0, observed: "ok" }));

        const missing = yield* Effect.flip(
          desktop.client["extensions.revoke"]({ id: PairingId.make("pair_missing") })
        );

        expect(missing).toEqual(new NotFound({ what: "pairing", id: "pair_missing" }));
        record(ExtensionsTraceEvent.cases.Revoke.make({ pairing: 7, observed: "unknown" }));
        // The other Extension is untouched.

        const other = yield* Effect.flip(
          ext2.client.dispatch({ commandId: CommandId.make("c4"), command: sendTurn })
        );

        expect(Predicate.isTagged(other, "CommandRejected")).toBe(true);
        record(
          ExtensionsTraceEvent.cases.Call.make({ connection: 3, need: "turn", observed: "allowed" })
        );

        return { open: server.connections() };
      })
    )
  );

  // Only the Desktop App and the other Extension remain; rejected hellos close too.
  expect(result.open).toBe(2);

  const decoded = decodeExtensionsTrace({
    format: "extensions-v1",
    provenance: "runtime-socket",
    events: trace,
  });

  expect(() => replayExtensions(decoded)).not.toThrow();

  const lastCall = decoded.events.findLastIndex(Predicate.isTagged("Call"));

  const mutant = decoded.events.map((event, index) =>
    index === lastCall && Predicate.isTagged(event, "Call")
      ? ExtensionsTraceEvent.cases.Call.make({ ...event, observed: "refused:turn" })
      : event
  );

  expect(() => replayExtensions({ ...decoded, events: mutant })).toThrow(
    "Extensions trace observation mismatch"
  );

  if (process.env.EXTENSIONS_TRACE_OUTPUT !== undefined)
    writeFileSync(process.env.EXTENSIONS_TRACE_OUTPUT, JSON.stringify(decoded, null, 2));
});

test("the pairing string names this Host and carries the token, with no url while Remote Access is off", async () => {
  const outcome = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporary;

        const server = yield* startServer({
          root,
          socketPath: join(root, "d.sock"),
          lockPath: join(root, "d.lock"),
          handlers,
        });

        const desktop = yield* Effect.flatMap(socketTransport(server.socketPath), (transport) =>
          connectRpcWith(ExtensionDaemonRpcs, transport)
        );

        const { host } = yield* desktop.client.hello({ ...hello(), ...TEST_USER_KEY });
        const paired = yield* desktop.client["extensions.pair"]({ name: "Glasses", grant: [] });

        return { host, paired };
      })
    )
  );

  expect(decodePairingString(outcome.paired.pairingString)).toEqual(
    Option.some({
      hostId: outcome.host.hostId,
      hostName: outcome.host.hostname,
      url: null,
      token: outcome.paired.token,
      name: "Glasses",
    })
  );
});
