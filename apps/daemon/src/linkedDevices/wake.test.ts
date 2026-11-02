/**
 * RelayRoute's wakes through a real relay process and a fake push service that answers
 * when the test says: the SQLite store, ticket checks and sealing are real.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { HostId, HostInfo, type LinkedDevice } from "@polaris/protocol";
import { type PushMessage, toBase64Url } from "@polaris/protocol/relay";
import { signPushTicket } from "@polaris/protocol/relay/party";
import { Effect, Fiber, Layer, Scope } from "effect";
import { pushSuite } from "../push/seal.ts";
import { HostSecrets } from "../secrets/index.ts";
import { makeDevice, startRelay, type TestDevice } from "./device.testing.ts";
import { DeviceConnections, RelayRoute } from "./route.ts";
import { LinkedDevices } from "./store.ts";
import { newTempDir, removeTempDirSettled } from "../platform/tempDir.testing.ts";

/** Requests the fake push service holds until the test answers them. */
const held: Array<{ readonly body: string; readonly answer: (outcome: string) => void }> = [];

const pushService = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const body = await request.text();
    const outcome = await new Promise<string>((answer) => held.push({ body, answer }));

    return Response.json({ outcome }, { status: outcome === "unregistered" ? 410 : 200 });
  },
});

let relay: Awaited<ReturnType<typeof startRelay>>;

beforeAll(async () => {
  relay = await startRelay(undefined, {
    POLARIS_RELAY_PUSH_URL: `http://127.0.0.1:${pushService.port}/api/push`,
    POLARIS_RELAY_PUSH_SECRET: "wake-test-secret-0123456789abcdef",
  });
});

afterAll(async () => {
  await relay.stop();
  void pushService.stop(true);
});

const hostInfo = new HostInfo({
  hostId: HostId.make("host_wake"),
  hostname: "Wake Host",
  platform: "darwin",
  daemonVersion: "0.0.0",
  homeDir: "/tmp",
  startedAt: new Date().toISOString(),
});

const routeLayer = (root: string) =>
  RelayRoute.layer({ root, hostInfo }).pipe(
    Layer.provide(
      Layer.mergeAll(
        LinkedDevices.layer(join(root, "linked-devices.sqlite")),
        HostSecrets.memory(),
        Layer.succeed(DeviceConnections)({ serve: (session) => session.close })
      )
    )
  );

const waitUntil = <A, E>(probe: Effect.Effect<A | undefined, E>, what: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 400; i++) {
      const found = yield* probe;

      if (found !== undefined) return found;
      yield* Effect.sleep("25 millis");
    }

    return yield* Effect.die(new Error(`timed out waiting for ${what}`));
  });

const message = (title: string): PushMessage => ({
  v: 1,
  kind: "needs-you",
  hostId: hostInfo.hostId,
  hostName: hostInfo.hostname,
  sessionId: "s1",
  requestId: "r1",
  category: "approval",
  title,
  subtitle: "",
  body: "",
  at: new Date().toISOString(),
});

/** A route on the relay with one Linked Device, and a registration maker for it. */
const linkedRoute = Effect.gen(function* () {
  const route = yield* RelayRoute;
  yield* route.enable(relay.url);
  yield* waitUntil(
    Effect.map(route.status, (status) => (status.connected ? true : undefined)),
    "the route to connect"
  );
  const { hostAddress } = yield* route.status;
  const phone: TestDevice = yield* Effect.promise(makeDevice);

  const device: LinkedDevice = yield* route.add({
    name: "Phone",
    relayAddress: phone.address,
    noiseKey: "A".repeat(43),
  });

  const keys = yield* Effect.promise(() => pushSuite.kem.generateKeyPair());

  const pushKey = toBase64Url(
    new Uint8Array(yield* Effect.promise(() => pushSuite.kem.serializePublicKey(keys.publicKey)))
  );

  const registration = (token: string) => ({
    token,
    environment: "sandbox" as const,
    pushKey,
    ticket: signPushTicket(phone.identity, hostAddress, "sandbox", token),
  });

  return { route, device, registration };
});

const run = <A, E>(body: Effect.Effect<A, E, RelayRoute | Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = newTempDir("pl-wake-", { short: true });
        yield* Effect.addFinalizer(() => Effect.promise(() => removeTempDirSettled(root)));

        return yield* body.pipe(Effect.provide(routeLayer(root)));
      })
    )
  );

test("an unregistered answer for an old token keeps the registration made since (RV4 / RX1-7)", async () => {
  await run(
    Effect.gen(function* () {
      const { route, device, registration } = yield* linkedRoute;
      yield* route.registerPush(device, registration("aa".repeat(32)));
      const [target] = route.pushTargets();

      if (target === undefined) throw new Error("the device has no registration");
      const wake = yield* Effect.forkChild(route.wake(target, message("Approve?")));

      const request = yield* waitUntil(
        Effect.sync(() => held[0]),
        "the push service to get the wake"
      );

      // The device registers a new token while APNs is still answering for the old one.
      yield* route.registerPush(device, registration("bb".repeat(32)));
      request.answer("unregistered");

      expect(yield* Fiber.join(wake)).toBe("unregistered");
      expect(route.pushTargets().map((t) => t.registration.token)).toEqual(["bb".repeat(32)]);

      held.length = 0;
    })
  );
}, 30_000);

test("a wake too large to fit is refused here, and the Host's relay socket stays up (RV3 / RX1-6)", async () => {
  await run(
    Effect.gen(function* () {
      const { route, device, registration } = yield* linkedRoute;
      yield* route.registerPush(device, registration("cc".repeat(32)));
      const [target] = route.pushTargets();

      if (target === undefined) throw new Error("the device has no registration");

      // Only the Host's own name, which no display cut shortens, can still overflow.
      const outcome = yield* route.wake(target, {
        ...message("Approve?"),
        hostName: "h".repeat(4000),
      });

      expect(outcome).toBe("refused");
      expect(held).toHaveLength(0);
      yield* Effect.sleep("200 millis");
      expect((yield* route.status).connected).toBe(true);
    })
  );
}, 30_000);
