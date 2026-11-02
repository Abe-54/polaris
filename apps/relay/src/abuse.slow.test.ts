import { afterEach, describe, expect, test } from "bun:test";
import { encodeControl, encodeDataFrame, RelayOp, toBase64Url } from "@polaris/protocol/relay";
import { generateRelayIdentity, proveRelayKey } from "@polaris/protocol/relay/party";
import { ConnectionGate, TokenBucket } from "./limits.ts";
import { TestParty } from "./testing/party.ts";
import { identify, startTestRelay, type TestRelay } from "./testing/relay.ts";

let relay: TestRelay;

afterEach(() => relay.stop());

const endedBy = (reason: string) =>
  relay.events.some((e) => e.event === "relay.connection" && e.endedBy === reason);

describe("relay key proof", () => {
  test("a signature by another key is refused", async () => {
    relay = startTestRelay();
    const party = await TestParty.open(relay.url);
    const challenge = await party.control("challenge");
    const impostor = generateRelayIdentity();
    party.sendText(
      encodeControl({
        t: "auth",
        role: "device",
        key: toBase64Url(party.identity.publicKey),
        sig: toBase64Url(
          proveRelayKey(impostor, Buffer.from(challenge.nonce, "base64url"), "device")
        ),
      })
    );

    expect(await party.closed).toEqual({ code: 4401, reason: "auth-failed" });
  });

  test("a proof made for the host role does not admit a device", async () => {
    relay = startTestRelay();
    const party = await TestParty.open(relay.url);
    const challenge = await party.control("challenge");
    party.sendText(
      encodeControl({
        t: "auth",
        role: "device",
        key: toBase64Url(party.identity.publicKey),
        sig: toBase64Url(
          proveRelayKey(party.identity, Buffer.from(challenge.nonce, "base64url"), "host")
        ),
      })
    );

    expect(await party.closed).toEqual({ code: 4401, reason: "auth-failed" });
  });

  test("a silent socket is closed at the auth timeout", async () => {
    relay = startTestRelay({ authTimeoutMs: 150 });
    const party = await TestParty.open(relay.url);

    expect(await party.closed).toEqual({ code: 4408, reason: "auth-timeout" });
  });

  test("data or peers before the proof, a second proof, and a device listing peers are refused", async () => {
    relay = startTestRelay();
    const early = await TestParty.open(relay.url);
    early.sendBytes(encodeDataFrame(RelayOp.Forward, "AAAAAAAAAAAAAAAAAAAAAA", new Uint8Array(10)));
    expect(await early.closed).toEqual({ code: 4400, reason: "data-before-ready" });

    const peersFirst = await TestParty.open(relay.url);
    peersFirst.setPeers([]);
    expect(await peersFirst.closed).toEqual({ code: 4400, reason: "peers-not-host" });

    const twice = await TestParty.connect(relay.url, "host");
    twice.sendText(encodeControl({ t: "auth", role: "host", key: "x", sig: "y" }));
    expect(await twice.closed).toEqual({ code: 4400, reason: "auth-twice" });

    const device = await TestParty.open(relay.url);
    const other = await identify();

    const refused = await device.authenticate("device", [other.address]).then(
      () => "ready",
      () => "refused"
    );

    expect(refused).toBe("refused");
    expect(await device.closed).toEqual({ code: 4401, reason: "auth-failed" });
  });

  test("a host may not list more devices than the limit", async () => {
    relay = startTestRelay({ maxPeers: 2 });
    const peers = await Promise.all([identify(), identify(), identify()]);

    const host = await TestParty.connect(relay.url, "host", {
      peers: peers.slice(0, 2).map((p) => p.address),
    });

    host.setPeers(peers.map((p) => p.address));
    expect(await host.closed).toEqual({ code: 4400, reason: "too-many-peers" });
  });

  test("malformed control and data are closed as bad messages", async () => {
    relay = startTestRelay();
    const garbage = await TestParty.open(relay.url);
    garbage.sendText("{not json");
    expect(await garbage.closed).toEqual({ code: 4400, reason: "bad-control" });

    const host = await TestParty.connect(relay.url, "host");
    host.sendBytes(new Uint8Array([9, 1, 1, 65]));
    expect(await host.closed).toEqual({ code: 4400, reason: "bad-frame" });
  });
});

describe("relay abuse limits", () => {
  test("a message over the size limit closes the socket", async () => {
    relay = startTestRelay();
    const p = await identify();
    const host = await TestParty.connect(relay.url, "host", { identity: p.identity });

    host.sendRecord(p.address, new Uint8Array(70_000));
    expect((await host.closed).code).toBe(1009);
  });

  test("a sender over its message rate is closed", async () => {
    relay = startTestRelay({ messagesPerSecond: 20 });
    const device = await TestParty.connect(relay.url, "device");
    const target = await identify();

    for (let i = 0; i < 100; i++) device.sendRecord(target.address, new Uint8Array(16));
    expect(await device.closed).toEqual({ code: 4429, reason: "rate-limited" });
    expect(endedBy("rate-limited")).toBe(true);
  });

  test("a sender over its byte rate is closed", async () => {
    relay = startTestRelay({ bytesPerSecond: 100_000 });
    const device = await TestParty.connect(relay.url, "device");
    const target = await identify();

    for (let i = 0; i < 10; i++) device.sendRecord(target.address, new Uint8Array(60_000));
    expect(await device.closed).toEqual({ code: 4429, reason: "rate-limited" });
  });

  test("one network address may hold only so many sockets, and frees them on close", async () => {
    relay = startTestRelay({ maxConnectionsPerIp: 2 });
    const first = await TestParty.open(relay.url);
    await TestParty.open(relay.url);

    const third = await TestParty.open(relay.url).then(
      () => "open",
      (error: Error) => error.message
    );

    expect(third).toBe("relay refused the socket");
    expect(relay.events).toContainEqual({ event: "relay.refused", reason: "too-many-connections" });
    await first.close();
    await TestParty.open(relay.url);
  });

  test("a silent socket is dropped at the idle timeout while a live party stays", async () => {
    relay = startTestRelay({ idleTimeoutSeconds: 1, authTimeoutMs: 60_000 });
    const p = await identify();
    const host = await TestParty.connect(relay.url, "host", { identity: p.identity });
    const started = performance.now();

    const silentClosed = new Promise<number>((resolve) => {
      void Bun.connect({
        hostname: "127.0.0.1",
        port: relay.port,
        socket: {
          open: (socket) =>
            void socket.write(
              "GET /v1 HTTP/1.1\r\nHost: relay\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
            ),
          data: () => undefined,
          close: () => resolve(performance.now() - started),
        },
      });
    });

    expect(await silentClosed).toBeLessThan(12_000);
    host.sendRecord(p.address, new Uint8Array(16));
    expect(await host.control("unreachable")).toEqual({ t: "unreachable", peer: p.address });
  }, 20_000);
});

describe("limits", () => {
  test("a token bucket refuses past its burst and refills with time", () => {
    let now = 0;
    const bucket = new TokenBucket(10, 20, () => now);

    expect(Array.from({ length: 25 }, () => bucket.take()).filter(Boolean)).toHaveLength(20);
    now = 500;
    expect(Array.from({ length: 10 }, () => bucket.take()).filter(Boolean)).toHaveLength(5);
  });

  test("the gate refuses a fast connector and a full relay", () => {
    let now = 0;

    const gate = new ConnectionGate(
      {
        maxConnections: 3,
        maxConnectionsPerIp: 10,
        connectsPerSecondPerIp: 1,
        connectBurstPerIp: 2,
      },
      () => now
    );

    expect([gate.admit("a"), gate.admit("a"), gate.admit("a")]).toEqual([
      null,
      null,
      "connecting-too-fast",
    ]);
    now = 1_000;
    expect(gate.admit("a")).toBeNull();
    expect(gate.admit("b")).toBe("relay-full");
    gate.release("a");
    expect(gate.admit("b")).toBeNull();
  });
});
