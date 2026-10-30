/**
 * The Relay route through a real relay process (ADR 0083): a device links with a link
 * string, reaches the Daemon with Client power and is recorded as the actor; unlinked
 * keys, other keys and other addresses are refused; unlinking ends the open connection;
 * a watcher sees each device's session open and close; and after the relay restarts the
 * Daemon declares its peers again.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { connectRpcWith, socketTransport } from "@polaris/client";
import {
  Actor,
  CommandId,
  CommandRejected,
  Command,
  DaemonRpcs,
  ExtensionDaemonRpcs,
  type LinkedDevice,
  type RelayRouteStatus,
  SessionId,
  SessionPlacement,
  WorkspaceId,
} from "@polaris/protocol";
import { fromBase64Url } from "@polaris/protocol/relay";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Redacted,
  Scope,
  Stream,
} from "effect";
import { DeviceLabel } from "../engine/rpc.ts";
import { actorOf } from "../extensions/connection.ts";
import { shortTemp } from "../platform/testing.ts";
import { HostSecrets } from "../secrets/index.ts";
import type { LinkTiming } from "./route.ts";
import { ServerRpcs } from "../transport/rpcs.ts";
import { startServer } from "../transport/server.ts";
import {
  DeviceSocket,
  handshake,
  link,
  makeDevice,
  sessionTransport,
  startRelay,
  type TestDevice,
} from "./device.testing.ts";

/** `dispatch` answers with who asked: the label and the Actor the Engine would record. */
const handlers = ServerRpcs.toLayerHandler("dispatch", ({ commandId }, { client }) =>
  Effect.fail(
    new CommandRejected({
      commandId,
      reason: `${Context.getOrUndefined(client.annotations, DeviceLabel)}|${JSON.stringify(actorOf(client))}`,
    })
  )
);

const sendTurn = Command.cases.SendTurn.make({
  sessionId: SessionId.make("s1"),
  prompt: "hi",
  attachments: [],
});

/** StartSession as the Mobile App sends it, with `fields` changed. */
const startSession = (fields: Partial<typeof Command.cases.StartSession.Type> = {}) =>
  Command.cases.StartSession.make({
    sessionId: SessionId.make("s2"),
    workspaceId: WorkspaceId.make("w1"),
    harness: "claude",
    placement: SessionPlacement.cases.InPlace.make({}),
    permissionMode: "plan",
    model: null,
    effort: null,
    prompt: "hi",
    attachments: [],
    ...fields,
  });

const hello = {
  clientName: "test",
  clientVersion: "0",
  deviceLabel: "Claimed label",
  capabilities: [],
};

let relay: Awaited<ReturnType<typeof startRelay>>;

beforeAll(async () => {
  relay = await startRelay();
});

afterAll(async () => {
  await relay.stop();
});

const key = (text: string) => Option.getOrThrow(fromBase64Url(text));

/** A started Daemon with the route on, and its Desktop App connection. */
const daemon = (scope: Scope.Scope, relayLinks?: LinkTiming) =>
  Effect.gen(function* () {
    const root = mkdtempSync(shortTemp("pl-relay-"));
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => rmSync(root, { recursive: true, force: true }))
    );

    const server = yield* startServer({
      root,
      socketPath: join(root, "d.sock"),
      lockPath: join(root, "d.lock"),
      handlers,
      secrets: HostSecrets.memory(),
      relayLinks,
    }).pipe(Scope.provide(scope));

    const desktop = yield* connectRpcWith(
      DaemonRpcs,
      yield* socketTransport(server.socketPath)
    ).pipe(Scope.provide(scope));

    yield* desktop.client.hello(hello);

    return desktop.client;
  });

type Desktop = Effect.Success<ReturnType<typeof daemon>>;

const waitConnected = (desktop: Desktop, connected = true) =>
  Effect.gen(function* () {
    for (let i = 0; i < 600; i++) {
      const status: RelayRouteStatus = yield* desktop["relayRoute.status"]();

      if (status.connected === connected) return status;
      yield* Effect.sleep("25 millis");
    }

    throw new Error(`the route never became ${connected ? "connected" : "disconnected"}`);
  });

const linkDevice = (desktop: Desktop, device: TestDevice, name: string) =>
  Effect.gen(function* () {
    const offer = yield* desktop["devices.link"]();
    const linked = yield* Effect.promise(() => link(offer.linkString, device, name));
    expect(linked.linked).toBe(true);

    return yield* desktop["devices.awaitLink"]({ linkId: offer.linkId });
  });

/** Opens a device session to the host and an RPC client over it; null when refused. */
const openSession = (
  status: RelayRouteStatus,
  device: TestDevice,
  noise = device.noise,
  tries = 4
) =>
  Effect.gen(function* () {
    const socket = yield* Effect.promise(() => DeviceSocket.connect(relay.url, device.identity));
    const host = { address: status.hostAddress, noiseKey: key(status.hostNoiseKey) };
    const session = yield* Effect.promise(() => handshake(socket, host, noise, undefined, tries));

    if (session === null) {
      socket.close();

      return null;
    }

    // The Extensions' group, so a device's `NotGranted` decodes.
    const connection = yield* connectRpcWith(
      ExtensionDaemonRpcs,
      sessionTransport(socket, status.hostAddress, session)
    );

    yield* connection.client.hello(hello);

    return { socket, client: connection.client };
  });

type DeviceClient = Effect.Success<ReturnType<typeof openSession>>;

const actorReason = (client: NonNullable<DeviceClient>["client"]) =>
  Effect.flip(client.dispatch({ commandId: CommandId.make("c1"), command: sendTurn })).pipe(
    Effect.map((error) => (error instanceof CommandRejected ? error.reason : String(error)))
  );

test("a linked device reaches the Daemon with Client power and is recorded as the actor; unlink ends it", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const desktop = yield* daemon(scope);

        // The route is off until turned on, and linking needs it on.
        expect((yield* desktop["relayRoute.status"]()).state).toBe("off");
        expect((yield* Effect.flip(desktop["devices.link"]())).reason).toBe("route-off");

        // RX1-10: no ws:// to a relay off this machine.
        const insecure = yield* Effect.flip(
          desktop["relayRoute.enable"]({ url: "ws://relay.example/v1" })
        );

        expect(insecure.reason).toBe("invalid-url");

        yield* desktop["relayRoute.enable"]({ url: relay.url });
        const status = yield* waitConnected(desktop);

        const phone = yield* Effect.promise(makeDevice);
        const device: LinkedDevice = yield* linkDevice(desktop, phone, "Test iPhone");
        expect(device.relayAddress).toBe(phone.address);
        expect(device.name).toBe("Test iPhone");

        const open = yield* openSession(status, phone);

        if (open === null) throw new Error("the linked device was refused");

        // Client power: a Client-only RPC answers, and dispatch records the device.
        expect((yield* open.client["devices.list"]()).map((d) => d.id)).toEqual([device.id]);
        expect(yield* actorReason(open.client)).toBe(
          `Test iPhone|${JSON.stringify(Actor.cases.LinkedDevice.make({ deviceId: device.id, name: "Test iPhone" }))}`
        );

        // RX1-1: a device can't plant another key, mint a link or a Pairing, or move the route.
        const planted = yield* Effect.promise(makeDevice);

        const refusals = yield* Effect.all([
          Effect.flip(
            open.client["devices.add"]({
              name: "Planted",
              relayAddress: planted.address,
              noiseKey: "A".repeat(43),
            })
          ),
          Effect.flip(open.client["devices.link"]()),
          Effect.flip(open.client["devices.unlink"]({ id: device.id })),
          Effect.flip(open.client["extensions.pair"]({ name: "x", grant: ["read"] })),
          Effect.flip(open.client["relayRoute.disable"]()),
          // ENG-495: a phone can't say the user is at the Mac and quiet its own pushes.
          Effect.flip(open.client["presence.report"]({ presence: "present" })),
          // RX2-1: what Mobile doesn't use is refused too, a stored credential or a shell.
          Effect.flip(
            open.client["voice.setKey"]({ provider: "deepgram", key: Redacted.make("planted") })
          ),
          Effect.flip(
            open.client.dispatch({
              commandId: CommandId.make("c2"),
              command: Command.cases.RunShellCommand.make({
                sessionId: SessionId.make("s1"),
                command: "touch planted",
              }),
            })
          ),
        ]);

        expect(new Set(refusals.map((error) => error._tag))).toEqual(new Set(["NotGranted"]));

        // RX3-1, ENG-458: a phone starts sessions in any mode; a hidden origin is refused.
        const start = (command: Command) =>
          Effect.flip(open.client.dispatch({ commandId: CommandId.make("c3"), command })).pipe(
            Effect.map((error) => error._tag)
          );

        const starts = yield* Effect.all([
          start(startSession()),
          start(
            startSession({
              permissionMode: "supervised",
              placement: SessionPlacement.cases.NewWorktree.make({
                branch: "polaris/hi-s2",
                baseRef: null,
              }),
            })
          ),
          start(startSession({ permissionMode: "auto-edits" })),
          start(startSession({ permissionMode: "auto" })),
          start(startSession({ permissionMode: "full-access" })),
          start(startSession({ origin: "reviewer" })),
        ]);

        expect(starts).toEqual([
          "CommandRejected",
          "CommandRejected",
          "CommandRejected",
          "CommandRejected",
          "CommandRejected",
          "NotGranted",
        ]);
        expect((yield* desktop["devices.list"]()).map((d) => d.name)).toEqual(["Test iPhone"]);

        // Unlink takes effect on the open connection: the session ends at once.
        yield* desktop["devices.unlink"]({ id: device.id });

        const after = yield* Effect.exit(
          open.client["devices.list"]().pipe(Effect.timeout("3 seconds"))
        );

        expect(Exit.isFailure(after)).toBe(true);

        // And the key no longer opens a session.
        expect(yield* openSession(status, phone, phone.noise, 1)).toBeNull();
        open.socket.close();
      })
    )
  );
}, 30_000);

test("a watcher sees a device's presence flip as its session opens and closes (ENG-629)", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const desktop = yield* daemon(scope);
        yield* desktop["relayRoute.enable"]({ url: relay.url });
        const status = yield* waitConnected(desktop);
        const phone = yield* Effect.promise(makeDevice);
        const device = yield* linkDevice(desktop, phone, "Test iPhone");

        const seen = yield* Queue.unbounded<ReadonlyArray<LinkedDevice>>();
        yield* desktop["devices.watch"]().pipe(
          Stream.runForEach((devices) => Queue.offer(seen, devices)),
          Effect.forkScoped
        );

        /** The watcher's next list in which the phone's presence is `connected`. */
        const until = (connected: boolean) =>
          Effect.gen(function* () {
            for (;;) {
              const devices = yield* Queue.take(seen);
              const since = devices.find((d) => d.id === device.id)?.connectedSince;

              if (since !== undefined && (since !== null) === connected) return since;
            }
          }).pipe(Effect.timeout("10 seconds"));

        expect(yield* until(false)).toBeNull();

        const before = new Date().toISOString();
        const open = yield* openSession(status, phone);

        if (open === null) throw new Error("the linked device was refused");
        const since = yield* until(true);
        expect((since ?? "") >= before).toBe(true);
        const listed = yield* desktop["devices.list"]();
        expect(listed.find((d) => d.id === device.id)?.connectedSince).toBe(since);

        // The phone goes away: the relay reports it offline and the session ends.
        open.socket.close();
        expect(yield* until(false)).toBeNull();
        const after = yield* desktop["devices.list"]();
        expect(after.find((d) => d.id === device.id)?.connectedSince).toBeNull();
      })
    )
  );
}, 30_000);

test("unknown keys, someone else's key and a used or wrong link are refused", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const desktop = yield* daemon(scope);
        yield* desktop["relayRoute.enable"]({ url: relay.url });
        const status = yield* waitConnected(desktop);

        const phone = yield* Effect.promise(makeDevice);
        const stranger = yield* Effect.promise(makeDevice);
        yield* linkDevice(desktop, phone, "Phone");

        // A device the Host never linked can't even reach it through the relay.
        expect(yield* openSession(status, stranger, stranger.noise, 1)).toBeNull();

        // The linked address with a Noise key that isn't the one stored with it.
        expect(yield* openSession(status, phone, stranger.noise, 1)).toBeNull();

        // The linked Noise key from another relay address.
        yield* desktop["devices.add"]({
          name: "Stranger",
          relayAddress: stranger.address,
          noiseKey: "A".repeat(43),
        });
        expect(yield* openSession(status, stranger, phone.noise, 1)).toBeNull();

        // A proof made with another secret is refused, even from the link's own address.
        const offer = yield* desktop["devices.link"]();

        const forged = yield* Effect.promise(() =>
          link(offer.linkString, stranger, "Forged", new Uint8Array(32).fill(7))
        );

        expect(forged.linked).toBe(false);

        // A link string works once.
        const late = yield* Effect.promise(makeDevice);
        expect((yield* Effect.promise(() => link(offer.linkString, late, "Late"))).linked).toBe(
          true
        );
        const reused = yield* Effect.promise(() => link(offer.linkString, stranger, "Reuse"));
        expect(reused.linked).toBe(false);

        const names = (yield* desktop["devices.list"]()).map((d) => d.name);
        expect(names).toEqual(["Phone", "Stranger", "Late"]);
      })
    )
  );
}, 40_000);

test("a cancelled, replaced or abandoned link no longer links (RX1-2)", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const desktop = yield* daemon(scope);
        yield* desktop["relayRoute.enable"]({ url: relay.url });
        yield* waitConnected(desktop);

        const linkWith = (linkString: string) =>
          Effect.flatMap(Effect.promise(makeDevice), (device) =>
            Effect.promise(() => link(linkString, device, "Late"))
          );

        // Cancel: the exact link stops working.
        const cancelled = yield* desktop["devices.link"]();
        yield* desktop["devices.cancelLink"]({ linkId: cancelled.linkId });
        expect((yield* linkWith(cancelled.linkString)).linked).toBe(false);

        // Reopening the panel replaces the link instead of adding a second live one.
        const replaced = yield* desktop["devices.link"]();
        const current = yield* desktop["devices.link"]();
        expect((yield* linkWith(replaced.linkString)).linked).toBe(false);

        // The Desktop App stops waiting (it quit or lost the Host): the link ends with it.
        const waiting = yield* Effect.forkChild(
          desktop["devices.awaitLink"]({ linkId: current.linkId })
        );

        yield* Effect.sleep("100 millis");
        yield* Fiber.interrupt(waiting);
        yield* Effect.sleep("100 millis");
        expect((yield* linkWith(current.linkString)).linked).toBe(false);

        expect(yield* desktop["devices.list"]()).toEqual([]);
      })
    )
  );
}, 40_000);

test("a phone that unlinks itself is refused from then on (RX1-3)", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const desktop = yield* daemon(scope);
        yield* desktop["relayRoute.enable"]({ url: relay.url });
        const status = yield* waitConnected(desktop);
        const phone = yield* Effect.promise(makeDevice);
        const device = yield* linkDevice(desktop, phone, "Phone");
        const open = yield* openSession(status, phone);

        if (open === null) throw new Error("the linked device was refused");

        // The Desktop App's own connection is not a Linked Device.
        expect((yield* Effect.flip(desktop["devices.unlinkSelf"]()))._tag).toBe("NotFound");

        const unlinked = yield* open.client["devices.unlinkSelf"]();

        expect(unlinked.id).toBe(device.id);
        expect((yield* desktop["devices.list"]()).map((d) => d.unlinkedAt === null)).toEqual([
          false,
        ]);
        yield* Effect.sleep("500 millis");
        expect(yield* openSession(status, phone, phone.noise, 1)).toBeNull();
        open.socket.close();
      })
    )
  );
}, 30_000);

test("the Daemon declares its peers again after the relay restarts", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const desktop = yield* daemon(scope);
        yield* desktop["relayRoute.enable"]({ url: relay.url });
        const status = yield* waitConnected(desktop);
        const phone = yield* Effect.promise(makeDevice);
        yield* linkDevice(desktop, phone, "Phone");

        yield* Effect.promise(() => relay.stop());
        yield* waitConnected(desktop, false);
        relay = yield* Effect.promise(() => startRelay(relay.port));
        yield* waitConnected(desktop);

        const open = yield* openSession(status, phone);
        expect(open).not.toBeNull();
        open?.socket.close();

        // Off closes the socket.
        yield* desktop["relayRoute.disable"]();
        expect((yield* waitConnected(desktop, false)).state).toBe("off");
      })
    )
  );
}, 40_000);

test.each(["cancelled", "expired"] as const)(
  "a link %s after the device proved it, before it completed, links nothing (RX2-2)",
  async (ending) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const admitted = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const completed = yield* Deferred.make<void>();

          // Holds the commit between admission and completion, as a slow relay socket would.
          const desktop = yield* daemon(scope, {
            ttlMs: ending === "expired" ? 3_000 : 60_000,
            completeWith: (completion) =>
              Deferred.succeed(admitted, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(completion),
                Effect.ensuring(Deferred.succeed(completed, undefined))
              ),
          });

          yield* desktop["relayRoute.enable"]({ url: relay.url });
          const status = yield* waitConnected(desktop);
          const offer = yield* desktop["devices.link"]();

          const waiting = yield* Effect.forkChild(
            desktop["devices.awaitLink"]({ linkId: offer.linkId })
          );

          const phone = yield* Effect.promise(makeDevice);

          expect((yield* Effect.promise(() => link(offer.linkString, phone, "Late"))).linked).toBe(
            true
          );
          yield* Deferred.await(admitted);

          if (ending === "cancelled")
            yield* desktop["devices.cancelLink"]({ linkId: offer.linkId });

          // The Desktop App is told the link ended, whichever way.
          expect((yield* Effect.flip(Fiber.join(waiting)))._tag).toBe("NotFound");

          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(completed);

          expect(yield* desktop["devices.list"]()).toEqual([]);
          expect(yield* openSession(status, phone, phone.noise, 1)).toBeNull();
        })
      )
    );
  },
  40_000
);
