import { afterEach, describe, expect, test } from "bun:test";
import { encodeJsonFrame, type Frame, FrameDecoder } from "@polaris/protocol";
import {
  acceptHandshake,
  generateStaticKeyPair,
  RelayInitiator,
  type RelaySession,
  type StaticKeyPair,
} from "@polaris/protocol/relay/party";
import { Predicate } from "effect";
import { TestParty } from "./testing/party.ts";
import { type Identified, identify, startTestRelay, type TestRelay } from "./testing/relay.ts";

let relay: TestRelay;

afterEach(() => relay.stop());

const sameKey = (a: Uint8Array) => (b: Uint8Array) => Buffer.compare(a, b) === 0;

interface Pair {
  readonly host: Identified & { readonly noise: StaticKeyPair };
  readonly device: Identified & { readonly noise: StaticKeyPair };
}

const pair = async (): Promise<Pair> => ({
  host: { ...(await identify()), noise: generateStaticKeyPair() },
  device: { ...(await identify()), noise: generateStaticKeyPair() },
});

const connectHost = (p: Pair) =>
  TestParty.connect(relay.url, "host", { identity: p.host.identity, peers: [p.device.address] });

const connectDevice = (p: Pair) =>
  TestParty.connect(relay.url, "device", { identity: p.device.identity });

/** The device dials the host through the relay; returns both ends of the Noise session. */
const handshake = async (p: Pair, host: TestParty, device: TestParty) => {
  const initiator = new RelayInitiator(p.device.noise, p.host.noise.publicKey);
  device.sendRecord(p.host.address, initiator.init);
  const init = await host.data();
  expect(init.peer).toBe(p.device.address);
  const accepted = acceptHandshake(p.host.noise, init.payload, sameKey(p.device.noise.publicKey));
  host.sendRecord(p.device.address, accepted.reply);
  const deviceSession = initiator.finish((await device.data()).payload);

  return { hostSession: accepted.session, deviceSession };
};

/** Sends protocol frames from one session to the other through the relay. */
const exchange = async (
  from: { party: TestParty; session: RelaySession },
  to: { party: TestParty; session: RelaySession; address: Identified["address"] },
  frames: ReadonlyArray<Uint8Array>
): Promise<Array<Frame>> => {
  const records = frames.flatMap((frame) => from.session.seal(frame));

  for (const record of records) from.party.sendRecord(to.address, record);
  const decoder = new FrameDecoder();
  const received: Array<Frame> = [];

  for (const _ of records)
    received.push(...decoder.push(to.session.open((await to.party.data()).payload)));

  return received;
};

const contains = (haystack: string | Uint8Array, needle: string) =>
  Buffer.from(haystack).includes(needle);

describe("relay", () => {
  test("two linked parties exchange encrypted frames; the relay is handed only ciphertext", async () => {
    relay = startTestRelay();
    const p = await pair();
    const host = await connectHost(p);
    const device = await connectDevice(p);
    expect(await host.control("presence")).toEqual({
      t: "presence",
      peer: p.device.address,
      online: true,
    });
    expect(await device.control("presence")).toEqual({
      t: "presence",
      peer: p.host.address,
      online: true,
    });

    const { hostSession, deviceSession } = await handshake(p, host, device);
    const marker = "secret-plaintext-4f2a";
    const request = encodeJsonFrame(JSON.stringify({ prompt: marker.repeat(10_000) }));

    const received = await exchange(
      { party: device, session: deviceSession },
      { party: host, session: hostSession, address: p.host.address },
      [request]
    );

    expect(received).toEqual([
      { kind: "json", text: JSON.stringify({ prompt: marker.repeat(10_000) }) },
    ]);

    const reply = await exchange(
      { party: host, session: hostSession },
      { party: device, session: deviceSession, address: p.device.address },
      [encodeJsonFrame(`{"answer":"${marker}"}`)]
    );

    expect(reply).toEqual([{ kind: "json", text: `{"answer":"${marker}"}` }]);

    for (const message of [...host.sent, ...device.sent])
      expect(contains(message, marker)).toBe(false);

    await device.close();
    await host.close();
    await relay.stop();
    const log = JSON.stringify(relay.events);
    expect(log).not.toContain(marker);

    for (const secret of [...p.host.secrets, ...p.device.secrets, "127.0.0.1"])
      expect(log).not.toContain(secret);
    const connections = relay.events.filter((e) => e.event === "relay.connection");
    expect(connections.map((e) => e.role ?? "").sort((a, b) => a.localeCompare(b))).toEqual([
      "device",
      "host",
    ]);
    expect(connections.find((e) => e.role === "device")).toMatchObject({
      authenticated: true,
      endedBy: "peer",
    });
  });

  test("a device the host does not link is unreachable both ways", async () => {
    relay = startTestRelay();
    const p = await pair();
    const stranger = await identify();
    const host = await connectHost(p);
    const intruder = await TestParty.connect(relay.url, "device", { identity: stranger.identity });

    intruder.sendRecord(p.host.address, new Uint8Array(32));
    expect(await intruder.control("unreachable")).toEqual({
      t: "unreachable",
      peer: p.host.address,
    });
    host.sendRecord(stranger.address, new Uint8Array(32));
    expect(await host.control("unreachable")).toEqual({ t: "unreachable", peer: stranger.address });
    expect(host.controls().some((m) => m.t === "presence")).toBe(false);
  });

  test("two hosts cannot reach each other, even when one lists the other", async () => {
    relay = startTestRelay();
    const a = await identify();
    const b = await identify();

    const hostA = await TestParty.connect(relay.url, "host", {
      identity: a.identity,
      peers: [b.address],
    });

    await TestParty.connect(relay.url, "host", { identity: b.identity, peers: [a.address] });

    hostA.sendRecord(b.address, new Uint8Array(16));
    expect(await hostA.control("unreachable")).toEqual({ t: "unreachable", peer: b.address });
  });

  test("a host unlinking a device announces it gone and stops routing to it", async () => {
    relay = startTestRelay();
    const p = await pair();
    const host = await connectHost(p);
    const device = await connectDevice(p);
    await host.control("presence");
    await device.control("presence");

    host.setPeers([]);
    expect(await device.control("presence")).toEqual({
      t: "presence",
      peer: p.host.address,
      online: false,
    });
    expect(await host.control("presence")).toEqual({
      t: "presence",
      peer: p.device.address,
      online: false,
    });
    device.sendRecord(p.host.address, new Uint8Array(16));
    expect(await device.control("unreachable")).toEqual({ t: "unreachable", peer: p.host.address });
  });
});

describe("relay forwarding", () => {
  /** Sizes either side of what the relay batches, so batched and direct writes interleave. */
  const SIZES = [16, 300, 9_000, 16, 40_000, 1_200, 16, 16, 65_544, 16];

  const record = (index: number, size: number) =>
    Uint8Array.from({ length: size }, (_, i) => (index * 31 + i) % 251);

  test("a burst of mixed sizes arrives whole, in order, from the sender's address", async () => {
    relay = startTestRelay({ messagesPerSecond: 10_000 });
    const p = await pair();
    const host = await connectHost(p);
    const device = await connectDevice(p);
    await host.control("presence");
    const sizes = Array.from({ length: 30 }, () => SIZES).flat();

    for (const [index, size] of sizes.entries())
      device.sendRecord(p.host.address, record(index, size));

    for (const [index, size] of sizes.entries()) {
      const frame = await host.data();
      expect(frame.peer).toBe(p.device.address);
      expect(Buffer.compare(frame.payload, record(index, size))).toBe(0);
    }
  });

  test("frames a party sent before it left arrive before the news that it left", async () => {
    relay = startTestRelay();
    const p = await pair();
    const host = await connectHost(p);
    const device = await connectDevice(p);
    await host.control("presence");
    const order: Array<string> = [];
    host.ws.addEventListener("message", (event) =>
      order.push(Predicate.isString(event.data) ? "control" : "data")
    );

    for (let index = 0; index < 20; index++) device.sendRecord(p.host.address, record(index, 64));
    await device.close();
    expect(await host.control("presence")).toMatchObject({ online: false });
    expect(order).toEqual([...Array.from({ length: 20 }, () => "data"), "control"]);
  });

  test("a forward the relay refuses, sent amid frames it forwards, loses none of them", async () => {
    relay = startTestRelay();
    const p = await pair();
    const stranger = await identify();
    const host = await connectHost(p);
    const device = await connectDevice(p);
    await host.control("presence");

    // The refusal goes straight to the host while its frames still wait for the turn's write.
    for (let index = 0; index < 5; index++) host.sendRecord(p.device.address, record(index, 64));
    host.sendRecord(stranger.address, record(9, 64));

    for (let index = 5; index < 8; index++) host.sendRecord(p.device.address, record(index, 64));
    expect(await host.control("unreachable")).toEqual({ t: "unreachable", peer: stranger.address });

    for (let index = 0; index < 8; index++)
      expect(Buffer.compare((await device.data()).payload, record(index, 64))).toBe(0);
  });
});

describe("relay reconnects", () => {
  test("a device that drops and reconnects is announced both times and handshakes again", async () => {
    relay = startTestRelay();
    const p = await pair();
    const host = await connectHost(p);
    const first = await connectDevice(p);
    await host.control("presence");
    await handshake(p, host, first);

    await first.close();
    expect(await host.control("presence")).toEqual({
      t: "presence",
      peer: p.device.address,
      online: false,
    });
    host.sendRecord(p.device.address, new Uint8Array(16));
    expect(await host.control("unreachable")).toEqual({ t: "unreachable", peer: p.device.address });

    const second = await connectDevice(p);
    expect(await host.control("presence")).toEqual({
      t: "presence",
      peer: p.device.address,
      online: true,
    });
    const { hostSession, deviceSession } = await handshake(p, host, second);

    const received = await exchange(
      { party: second, session: deviceSession },
      { party: host, session: hostSession, address: p.host.address },
      [encodeJsonFrame('{"resume":true}')]
    );

    expect(received).toEqual([{ kind: "json", text: '{"resume":true}' }]);
  });

  test("a host that restarts is announced gone, then back with its linked devices", async () => {
    relay = startTestRelay();
    const p = await pair();
    const firstHost = await connectHost(p);
    const device = await connectDevice(p);
    await device.control("presence");

    await firstHost.close();
    expect(await device.control("presence")).toEqual({
      t: "presence",
      peer: p.host.address,
      online: false,
    });
    device.sendRecord(p.host.address, new Uint8Array(16));
    expect(await device.control("unreachable")).toEqual({ t: "unreachable", peer: p.host.address });

    const host = await connectHost(p);
    expect(await device.control("presence")).toEqual({
      t: "presence",
      peer: p.host.address,
      online: true,
    });
    await handshake(p, host, device);
  });

  test("a newer connection with the same key replaces the older one", async () => {
    relay = startTestRelay();
    const p = await pair();
    const host = await connectHost(p);
    const stale = await connectDevice(p);
    const fresh = await connectDevice(p);

    expect(await stale.closed).toEqual({ code: 4409, reason: "replaced" });
    await handshake(p, host, fresh);
    expect(stale.controls().filter((m) => m.t === "unreachable")).toEqual([]);
  });
});

test("the relay's code never names the end-to-end channel or a cipher for it", async () => {
  const root = `${import.meta.dir}/..`;

  // Windows scans with backslashes.
  const sources = [
    ...[...new Bun.Glob("src/**/*.rs").scanSync(root)].map((path) => path.replaceAll("\\", "/")),
    "Cargo.toml",
  ];

  expect(sources).toContain("src/server.rs");

  for (const path of sources) {
    const source = (await Bun.file(`${root}/${path}`).text()).toLowerCase();
    const names = ["noise", "snow", "x25519", "chacha"].filter((name) => source.includes(name));
    expect({ path, names }).toEqual({ path, names: [] });
  }
});
