/**
 * Presence over the real transport (ENG-495): a Desktop App connection's report is a lease
 * that ends on `away`, when it lapses, or the moment its connection closes.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { connectRpcWith, socketTransport } from "@polaris/client";
import { DaemonRpcs } from "@polaris/protocol";
import { Effect, Exit, Layer, Scope } from "effect";
import { shortTemp } from "../platform/testing.ts";
import { HostSecrets } from "../secrets/index.ts";
import { startServer } from "../transport/server.ts";
import { HostPresence } from "./index.ts";

const hello = { clientName: "test", clientVersion: "0", deviceLabel: "test", capabilities: [] };

/** A Daemon with a `leaseMs` lease, the transport's own HostPresence, and a way to connect. */
const daemon = (leaseMs: number) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const root = mkdtempSync(shortTemp("pl-presence-"));
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => rmSync(root, { recursive: true, force: true }))
    );
    const found: Array<HostPresence["Service"]> = [];

    const server = yield* startServer({
      root,
      socketPath: join(root, "d.sock"),
      lockPath: join(root, "d.lock"),
      handlers: Layer.effectDiscard(Effect.map(HostPresence, (presence) => found.push(presence))),
      secrets: HostSecrets.memory(),
      presence: { leaseMs },
    });

    const presence = found[0];

    if (presence === undefined) throw new Error("the handlers never saw HostPresence");

    const connect = Effect.gen(function* () {
      const connectionScope = yield* Scope.make();

      const connection = yield* connectRpcWith(
        DaemonRpcs,
        yield* socketTransport(server.socketPath)
      ).pipe(Scope.provide(connectionScope));

      yield* connection.client.hello(hello);

      return { client: connection.client, close: Scope.close(connectionScope, Exit.void) };
    });

    return { presence, connect };
  });

/** Polls `probe` for up to a second: the server sees a closed socket a moment later. */
const eventually = (probe: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 100 && !probe(); i++) yield* Effect.sleep("10 millis");

    return probe();
  });

test("a Desktop App's present holds until away, and a closed connection ends it at once", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { presence, connect } = yield* daemon(60_000);
        const mac = yield* connect;
        const laptop = yield* connect;

        expect(presence.present()).toBe(false);
        expect((yield* mac.client["presence.report"]({ presence: "present" })).leaseMs).toBe(
          60_000
        );
        yield* laptop.client["presence.report"]({ presence: "present" });
        expect(presence.present()).toBe(true);

        // Any one present Desktop App keeps the Host quiet.
        expect((yield* mac.client["presence.report"]({ presence: "away" })).leaseMs).toBe(0);
        expect(presence.present()).toBe(true);

        yield* laptop.close;
        expect(yield* eventually(() => !presence.present())).toBe(true);
      })
    )
  ));

test("a present lease that isn't renewed lapses", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { presence, connect } = yield* daemon(200);
        const mac = yield* connect;

        yield* mac.client["presence.report"]({ presence: "present" });
        yield* Effect.sleep("100 millis");
        // A renewal moves the lapse on.
        yield* mac.client["presence.report"]({ presence: "present" });
        yield* Effect.sleep("150 millis");
        expect(presence.present()).toBe(true);
        yield* Effect.sleep("150 millis");
        expect(presence.present()).toBe(false);
      })
    )
  ));

test("the connection that reported present most recently is remembered, through away, until it closes", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { presence, connect } = yield* daemon(60_000);
        const mac = yield* connect;
        const laptop = yield* connect;
        const ids = Array.from({ length: 2 }, (_, i) => i);

        expect(ids.map((id) => presence.lastPresentAt(id))).toEqual([null, null]);
        yield* mac.client["presence.report"]({ presence: "present" });
        yield* Effect.sleep("5 millis");
        yield* laptop.client["presence.report"]({ presence: "present" });
        const macAt = presence.lastPresentAt(0) ?? Number.NaN;
        const laptopAt = presence.lastPresentAt(1) ?? Number.NaN;

        expect(laptopAt).toBeGreaterThan(macAt);

        // Away ends the lease but keeps when the user was last there; closing forgets it.
        yield* laptop.client["presence.report"]({ presence: "away" });
        expect(presence.lastPresentAt(1)).toBe(laptopAt);
        yield* laptop.close;
        expect(yield* eventually(() => presence.lastPresentAt(1) === null)).toBe(true);
        expect(presence.lastPresentAt(0)).toBe(macAt);
      })
    )
  ));
