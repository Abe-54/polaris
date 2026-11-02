/**
 * The phone's path end to end, on Bun: a fresh device links once through a real relay
 * process with the Desktop App's link string, reaches the real Daemon with Client power
 * over the Connection State seam, and its host feed resumes across a relay restart.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  deviceKeys,
  generateDeviceSecrets,
  type LinkedHost,
  linkDevice,
  makeRelayDevice,
  readLink,
  type RelayDevice,
} from "@polaris/client/relay";
import { openHostFeed } from "@polaris/client/resume";
import { encodeLinkEnvelope, type HostStreamItem } from "@polaris/protocol";
import { Effect, Exit, Fiber, Predicate, Scope, Stream } from "effect";
import { type HostConnection, openHostConnection } from "../src/runtime/hostConnection.ts";
import {
  launchRelayDaemon,
  relayProcess,
  type RelayDaemon,
  silentPath,
  type TestRelay,
} from "./relay.testing.ts";
import { relayTransport } from "../src/relay/transport.ts";
import { revokeOnHosts } from "../src/relay/unlink.ts";

let relay: TestRelay;

let host: RelayDaemon;

beforeAll(async () => {
  relay = relayProcess();
  await relay.start();
  host = await launchRelayDaemon(relay.url);
}, 60_000);

afterAll(async () => {
  await host?.stop();
  await relay?.stop();
});

const until = async (what: string, ready: () => boolean, ms = 30_000) => {
  const deadline = Date.now() + ms;

  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
};

/** The HostConnection as the feed's source: each live connection, by epoch. */
const liveSource = (connection: HostConnection) => ({
  next: (minEpoch: number) =>
    Effect.promise(async () => {
      await until("a live connection", () => (connection.live()?.epoch ?? 0) >= minEpoch, 60_000);
      // SAFETY: `until` returned only once live() held a connection.
      const live = connection.live()!;

      return { epoch: live.epoch, client: live.client };
    }),
});

const linkFresh = async (): Promise<{ device: RelayDevice; hosts: ReadonlyArray<LinkedHost> }> => {
  const offer = await Effect.runPromise(host.client["devices.link"]());
  const awaited = Effect.runPromise(host.client["devices.awaitLink"]({ linkId: offer.linkId }));
  const keys = await deviceKeys(generateDeviceSecrets());

  const hosts = await Effect.runPromise(
    Effect.flatMap(readLink(offer.linkString), (envelope) =>
      linkDevice(envelope, keys, "Test iPhone")
    )
  );

  const linked = await awaited;
  expect(linked.relayAddress).toBe(keys.address);

  return { device: makeRelayDevice(keys, { backoff: () => 100 }), hosts };
};

test("a v2 link names every Host, the linking one first", async () => {
  const offer = await Effect.runPromise(host.client["devices.link"]());
  const { link } = await Effect.runPromise(readLink(offer.linkString));

  const other = {
    hostId: link.hostId,
    hostName: "Mac Studio",
    relayUrl: link.relayUrl,
    hostAddress: link.hostAddress,
    hostNoiseKey: link.hostNoiseKey,
  };

  const v2 = encodeLinkEnvelope({ link, hosts: [{ ...other, hostId: other.hostId }] });
  const keys = await deviceKeys(generateDeviceSecrets());

  const hosts = await Effect.runPromise(
    Effect.flatMap(readLink(v2), (envelope) => linkDevice(envelope, keys, "Test iPhone"))
  );

  expect(hosts.map((h) => h.hostName)).toEqual([link.hostName, "Mac Studio"]);
}, 30_000);

test("a used link is refused, so the relay or a second phone can't reuse it", async () => {
  const offer = await Effect.runPromise(host.client["devices.link"]());
  const envelope = await Effect.runPromise(readLink(offer.linkString));
  const first = await deviceKeys(generateDeviceSecrets());
  await Effect.runPromise(linkDevice(envelope, first, "First"));
  const second = await deviceKeys(generateDeviceSecrets());

  const failure = await Effect.runPromise(Effect.flip(linkDevice(envelope, second, "Second")));
  expect(failure.reason).toBe("no-answer");
}, 30_000);

test("a linked device connects with Client power, and its feed resumes across a relay restart", async () => {
  const { device, hosts } = await linkFresh();
  const [linked] = hosts;

  if (linked === undefined) throw new Error("the link named no Host");

  const connection = openHostConnection({
    hostId: linked.hostId,
    name: linked.hostName,
    transport: relayTransport(device, linked),
    policy: { initialDelayMs: 100, maxDelayMs: 1_000 },
  });

  try {
    await until("the first connection", () => connection.live() !== null);
    expect(connection.status().host?.hostId).toBe(host.daemon.hostId);
    expect(connection.route).toBe("relay");
    // devices.list is Client-only: an Extension or an unlinked socket is refused it.
    const devices = await connection.run((client) => client["devices.list"]());
    expect(devices.map((d) => d.relayAddress)).toContain(device.keys.address);

    const items: Array<HostStreamItem> = [];
    const feedScope = Effect.runSync(Scope.make());

    const feed = await Effect.runPromise(
      Scope.provide(openHostFeed(liveSource(connection)), feedScope)
    );

    const fiber = Effect.runFork(
      Stream.runForEach(feed.stream, (item) => Effect.sync(() => items.push(item)))
    );

    await until("the snapshot", () => items.some(Predicate.isTagged("Synchronized")));
    const events = () => items.flatMap((item) => (Predicate.isTagged(item, "Event") ? [item] : []));
    const before = events().length;

    await host.daemon.registerWorkspace();
    await until("the first event", () => events().length > before);
    const firstEpoch = connection.status().epoch;

    await relay.stop();
    await until("the drop", () => connection.live() === null);
    // Happens while the device can't reach the Host: resume must deliver it.
    await host.daemon.registerWorkspace();
    const missed = events().length;
    await relay.start();

    await until("the reconnect", () => (connection.live()?.epoch ?? 0) > firstEpoch, 60_000);
    await until("the event made while away", () => events().length > missed, 60_000);

    const snapshots = items.filter(Predicate.isTagged("Snapshot"));
    const sequences = events().map((item) => item.envelope.sequence);
    // Resumed, not restarted: one Snapshot, and every event once, in order.
    expect(snapshots.length).toBe(1);
    expect(sequences).toEqual([...new Set(sequences)].sort((a, b) => a - b));
    await Effect.runPromise(Fiber.interrupt(fiber));
    await Effect.runPromise(Scope.close(feedScope, Exit.void));
  } finally {
    await connection.close();
    device.close();
  }
}, 120_000);

// RX1-3: Unlink on the phone revokes its key on the Host, not only in the Keychain.
test("after Unlink on the phone, the Host refuses its old key", async () => {
  const { device, hosts } = await linkFresh();
  const [linked] = hosts;

  if (linked === undefined) throw new Error("the link named no Host");

  const open = (relayDevice: RelayDevice) =>
    openHostConnection({
      hostId: linked.hostId,
      name: linked.hostName,
      transport: relayTransport(relayDevice, linked),
      policy: { initialDelayMs: 100, maxDelayMs: 1_000 },
    });

  const connection = open(device);

  try {
    await until("the first connection", () => connection.live() !== null);
    expect([...(await revokeOnHosts([connection]))]).toEqual([linked.hostId]);

    const listed = await Effect.runPromise(host.client["devices.list"]());
    const row = listed.find((d) => d.relayAddress === device.keys.address);
    expect(row?.unlinkedAt).not.toBeNull();
  } finally {
    await connection.close();
    device.close();
  }

  // Someone who copied the keys can't come back with them.
  const stolen = makeRelayDevice(device.keys, { backoff: () => 100 });
  const again = open(stolen);

  try {
    await Bun.sleep(2_000);
    expect(again.live()).toBeNull();
  } finally {
    await again.close();
    stolen.close();
  }
}, 60_000);

// ENG-484: the relay's pings never reach JS, so only the phone itself finds a dead link: by its
// pings, or at once when the app comes back to the front (`checkAlive`).
test.each([
  { found: "by its pings", pingIntervalMs: 200, checkAlive: false },
  { found: "coming back to the front", pingIntervalMs: 600_000, checkAlive: true },
])(
  "a feed over a link that dies without closing is found $found and catches up",
  async (how) => {
    const { device, hosts } = await linkFresh();
    const [linked] = hosts;

    if (linked === undefined) throw new Error("the link named no Host");
    const path = silentPath(relay.url);

    const connection = openHostConnection({
      hostId: linked.hostId,
      name: linked.hostName,
      transport: relayTransport(device, { ...linked, relayUrl: path.url }),
      policy: { initialDelayMs: 100, maxDelayMs: 1_000 },
      pingIntervalMs: how.pingIntervalMs,
      aliveTimeoutMs: 500,
    });

    const feedScope = Effect.runSync(Scope.make());

    try {
      await until("the first connection", () => connection.live() !== null);
      const items: Array<HostStreamItem> = [];

      const feed = await Effect.runPromise(
        Scope.provide(openHostFeed(liveSource(connection)), feedScope)
      );

      Effect.runFork(Stream.runForEach(feed.stream, (item) => Effect.sync(() => items.push(item))));
      await until("the snapshot", () => items.some(Predicate.isTagged("Synchronized")));
      const events = () => items.filter(Predicate.isTagged("Event")).length;

      path.cut();
      // Made after the link died: the phone must notice and resume to see it.
      await host.daemon.registerWorkspace();
      const missed = events();

      if (how.checkAlive) connection.checkAlive();
      await until("the event made after the link died", () => events() > missed, 20_000);
      expect(connection.status().epoch).toBeGreaterThan(1);
    } finally {
      await Effect.runPromise(Scope.close(feedScope, Exit.void));
      await connection.close();
      device.close();
      path.stop();
    }
  },
  60_000
);
