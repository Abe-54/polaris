/**
 * The Live Activity from the Host stream to the push service (ADR 0088): the real route,
 * LiveNotifier, SQLite store, sealing and relay process; fakes only for the Host stream and
 * the push service. The test opens each slice with the device's push key, as the widget does.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { HostId, HostInfo, type HostStreamItem, type LinkedDevice } from "@polaris/protocol";
import {
  fromBase64Url,
  HostSlice,
  LIVE_HPKE_INFO,
  LivePushRequest,
  PUSH_ENC_BYTES,
  toBase64Url,
} from "@polaris/protocol/relay";
import { signLiveTicket, signPushTicket } from "@polaris/protocol/relay/party";
import { Context, Effect, Layer, Option, PubSub, Schema, Scope, Stream } from "effect";
import { makeDevice, startRelay, type TestDevice } from "../linkedDevices/device.testing.ts";
import { DeviceConnections, RelayRoute } from "../linkedDevices/route.ts";
import { LinkedDevices } from "../linkedDevices/store.ts";
import { HostSecrets } from "../secrets/index.ts";
import { LiveHostEvents, LiveNotifier } from "./liveNotifier.ts";
import { approvalRequested, session, snapshot, synchronized, waitUntil } from "./push.testing.ts";
import { pushSuite } from "./seal.ts";
import { newTempDir, removeTempDirSettled } from "../platform/tempDir.testing.ts";

const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(LivePushRequest));

const received: Array<LivePushRequest> = [];

/** What the fake push service answers next; `sent` by default. */
let answer = "sent";

const pushService = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    received.push(decodeRequest(await request.text()));

    return Response.json({ outcome: answer }, { status: answer === "sent" ? 200 : 410 });
  },
});

let relay: Awaited<ReturnType<typeof startRelay>>;

beforeAll(async () => {
  relay = await startRelay(undefined, {
    POLARIS_RELAY_PUSH_URL: `http://127.0.0.1:${pushService.port}/api/push`,
    POLARIS_RELAY_PUSH_SECRET: "live-e2e-secret-0123456789abcdef",
  });
});

afterAll(async () => {
  await relay.stop();
  void pushService.stop(true);
});

const hostInfo = new HostInfo({
  hostId: HostId.make("host_live"),
  hostname: "Studio",
  platform: "darwin",
  daemonVersion: "0.0.0",
  homeDir: "/tmp",
  startedAt: new Date().toISOString(),
});

const keys = await pushSuite.kem.generateKeyPair();

const pushKey = toBase64Url(new Uint8Array(await pushSuite.kem.serializePublicKey(keys.publicKey)));

const openSlice = async (sealed: string) => {
  const bytes = Option.getOrThrow(fromBase64Url(sealed));

  const recipient = await pushSuite.createRecipientContext({
    recipientKey: keys.privateKey,
    enc: new Uint8Array(bytes.subarray(0, PUSH_ENC_BYTES)),
    info: new TextEncoder().encode(LIVE_HPKE_INFO),
  });

  return Schema.decodeUnknownSync(Schema.fromJsonString(HostSlice))(
    new TextDecoder().decode(await recipient.open(new Uint8Array(bytes.subarray(PUSH_ENC_BYTES))))
  );
};

const TOKEN = "d4".repeat(40);

/** A connected route with one Linked Device, the notifier on a fake Host stream, and a feed. */
const setup = Effect.gen(function* () {
  const root = newTempDir("pl-live-", { short: true });
  yield* Effect.addFinalizer(() => Effect.promise(() => removeTempDirSettled(root)));

  const routeLayer = RelayRoute.layer({ root, hostInfo }).pipe(
    Layer.provide(
      Layer.mergeAll(
        LinkedDevices.layer(join(root, "linked-devices.sqlite")),
        HostSecrets.memory(),
        Layer.succeed(DeviceConnections)({ serve: (s) => s.close })
      )
    )
  );

  const route = Context.get(yield* Layer.build(routeLayer), RelayRoute);
  yield* route.enable(relay.url);
  const events = yield* PubSub.unbounded<HostStreamItem>();

  yield* Layer.build(
    LiveNotifier.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(LiveHostEvents)({
            subscribe: () =>
              Stream.concat(Stream.make(snapshot(), synchronized()), Stream.fromPubSub(events)),
          }),
          Layer.succeed(RelayRoute)(route)
        )
      )
    )
  );

  const phone: TestDevice = yield* Effect.promise(makeDevice);

  const device: LinkedDevice = yield* route.add({
    name: "Phone",
    relayAddress: phone.address,
    noiseKey: "A".repeat(43),
  });

  return {
    route,
    device,
    phone,
    feed: (item: HostStreamItem) => Effect.runSync(PubSub.publish(events, item)),
  };
});

const run = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(body));

test("a registered activity gets this Host's sealed slice, and a new Needs You at once with the alert", async () => {
  await run(
    Effect.gen(function* () {
      received.length = 0;
      const { route, device, phone, feed } = yield* setup;

      const { hostAddress } = yield* waitUntil(() => {
        const status = Effect.runSync(Effect.orDie(route.status));

        return status.connected ? status : undefined;
      }, "the route to connect");

      yield* route.registerLiveActivity(device, {
        token: TOKEN,
        environment: "sandbox",
        pushKey,
        ticket: signLiveTicket(phone.identity, hostAddress, "sandbox", TOKEN),
      });

      const first = yield* waitUntil(() => received[0], "the first slice");
      expect([first.token, first.live.alert, first.live.state.slices.length]).toEqual([
        TOKEN,
        false,
        1,
      ]);
      const opened = yield* Effect.promise(() => openSlice(first.live.state.slices[0] ?? ""));
      expect(opened).toMatchObject({ hostId: "host_live", host: "Studio", working: 1, need: null });

      feed(approvalRequested("r1"));
      const second = yield* waitUntil(() => received[1], "the Needs You");
      expect(second.live.alert).toBe(true);
      const need = yield* Effect.promise(() => openSlice(second.live.state.slices[0] ?? ""));
      expect(need.need).toMatchObject({
        requestId: "r1",
        session: session.title,
        line: "Run bun test",
      });
      expect(need.seq).toBeGreaterThan(opened.seq);
    })
  );
}, 30_000);

test("only a live ticket for this Host's address registers", async () => {
  await run(
    Effect.gen(function* () {
      const { route, device, phone } = yield* setup;
      const { hostAddress } = yield* route.status;
      const other = yield* Effect.promise(makeDevice);

      for (const ticket of [
        signPushTicket(phone.identity, hostAddress, "sandbox", TOKEN),
        signLiveTicket(phone.identity, other.address, "sandbox", TOKEN),
      ]) {
        const refused = yield* Effect.flip(
          route.registerLiveActivity(device, {
            token: TOKEN,
            environment: "sandbox",
            pushKey,
            ticket,
          })
        );

        expect(refused.message).toContain("live ticket");
      }

      expect(route.liveTargets()).toEqual([]);
    })
  );
}, 30_000);

test("an activity APNs no longer knows is forgotten here", async () => {
  await run(
    Effect.gen(function* () {
      received.length = 0;
      answer = "unregistered";
      const { route, device, phone } = yield* setup;

      const { hostAddress } = yield* waitUntil(() => {
        const status = Effect.runSync(Effect.orDie(route.status));

        return status.connected ? status : undefined;
      }, "the route to connect");

      yield* route.registerLiveActivity(device, {
        token: TOKEN,
        environment: "sandbox",
        pushKey,
        ticket: signLiveTicket(phone.identity, hostAddress, "sandbox", TOKEN),
      });

      yield* waitUntil(() => (route.liveTargets().length === 0 ? true : undefined), "live-gone");
      expect(received).toHaveLength(1);
      answer = "sent";
    })
  );
}, 30_000);
