import { afterEach, describe, expect, test } from "bun:test";
import {
  encodeControl,
  PushHeaders,
  PushRequest,
  RelayClose,
  verifyPushRequest,
  Wake,
  type WakeOutcome,
} from "@polaris/protocol/relay";
import { Schema } from "effect";
import { TestParty } from "./testing/party.ts";
import { type Identified, identify, startTestRelay, type TestRelay } from "./testing/relay.ts";
import { signPushTicket } from "@polaris/protocol/relay/party";

const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(PushRequest));

const SECRET = "test-secret-0123456789abcdef0123456789";

const TOKEN = "a1".repeat(32);

const PAYLOAD = "c2VhbGVkLXBheWxvYWQtdGhlLXJlbGF5LWNhbm5vdC1yZWFk";

interface FakeService {
  readonly url: string;
  readonly received: Array<{ readonly body: PushRequest; readonly verified: boolean }>;
  stop(): void;
}

/** A push service that checks the relay's signature and answers with `outcome`. */
const fakeService = (outcome: WakeOutcome = "sent", status = 200): FakeService => {
  const received: FakeService["received"] = [];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const body = await request.text();
      const headers = request.headers;

      const verified = await verifyPushRequest(
        SECRET,
        {
          method: request.method,
          path: new URL(request.url).pathname,
          timestamp: headers.get(PushHeaders.timestamp) ?? "",
          nonce: headers.get(PushHeaders.nonce) ?? "",
          body,
        },
        headers.get(PushHeaders.signature) ?? ""
      );

      received.push({ body: decodeRequest(body), verified });

      return Response.json({ outcome }, { status });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/api/push`,
    received,
    stop: () => void server.stop(true),
  };
};

let relay: TestRelay;

let service: FakeService | null = null;

afterEach(async () => {
  service?.stop();
  service = null;
  await relay.stop();
});

/** A wake from `host` for `device`, carrying the ticket `signer` signed (the device, by default). */
const wake = (
  device: Identified,
  host: TestParty,
  id = "w1",
  signer: Identified = device
): string =>
  encodeControl({
    t: "wake",
    id,
    peer: device.address,
    token: TOKEN,
    environment: "sandbox",
    ticket: signPushTicket(signer.identity, host.address ?? device.address, "sandbox", TOKEN),
    payload: PAYLOAD,
  });

const decodeWake = Schema.decodeUnknownSync(Schema.fromJsonString(Wake));

const challengeOf = (party: TestParty) =>
  party.received.find((message) => message.t === "challenge");

const withService = (outcome?: WakeOutcome, status?: number) => {
  service = fakeService(outcome, status);
  relay = startTestRelay({ push: { url: service.url, secret: SECRET } });

  return service;
};

describe("wakes", () => {
  test("a host wakes an offline device it lists; the service gets a signed request and the logs nothing", async () => {
    const push = withService();
    const device = await identify();
    const host = await TestParty.connect(relay.url, "host", { peers: [device.address] });

    host.sendText(wake(device, host));
    expect(await host.control("woken")).toEqual({ t: "woken", id: "w1", outcome: "sent" });

    expect(push.received).toEqual([
      {
        body: { token: TOKEN, environment: "sandbox", payload: PAYLOAD },
        verified: true,
      },
    ]);
    await host.close();
    const logged = JSON.stringify(relay.events);

    for (const secret of [TOKEN, PAYLOAD, ...device.secrets]) expect(logged).not.toContain(secret);
    expect(relay.events.filter((e) => e.event === "relay.wake").map((e) => e.outcome)).toEqual([
      "sent",
    ]);
  });

  test("without the device's own ticket for this host, a wake never reaches the service", async () => {
    const push = withService();
    const device = await identify();
    const stranger = await identify();
    const host = await TestParty.connect(relay.url, "host", { peers: [device.address] });
    const otherHost = await TestParty.connect(relay.url, "host", { peers: [device.address] });

    // Signed by another key for the device's address, then a real ticket replayed by another host.
    host.sendText(wake(device, host, "forged", stranger));
    otherHost.sendText(encodeControl({ ...decodeWake(wake(device, host, "replayed")) }));
    expect((await host.control("woken")).outcome).toBe("unlinked");
    expect((await otherHost.control("woken")).outcome).toBe("unlinked");
    expect(push.received).toEqual([]);
  });

  test("a device can't send a wake", async () => {
    withService();
    const host = await identify();
    const device = await TestParty.connect(relay.url, "device");

    device.sendText(wake(host, device));
    expect((await device.closed).code).toBe(RelayClose.BadMessage);
  });

  test("a host past its wake burst is answered rate-limited, across reconnects", async () => {
    service = fakeService();
    relay = startTestRelay({
      push: { url: service.url, secret: SECRET },
      wakeBurst: 2,
      wakesPerMinute: 1,
    });
    const device = await identify();
    const host = await TestParty.connect(relay.url, "host", { peers: [device.address] });

    for (const id of ["a", "b", "c"]) host.sendText(wake(device, host, id));
    const outcomes = [];

    for (let i = 0; i < 3; i++) outcomes.push(await host.control("woken"));
    expect(Object.fromEntries(outcomes.map((o) => [o.id, o.outcome]))).toEqual({
      a: "sent",
      b: "sent",
      c: "rate-limited",
    });
    expect(service.received).toHaveLength(2);

    // Reconnecting with the same key doesn't refill the budget.
    await host.close();

    const again = await TestParty.connect(relay.url, "host", {
      identity: host.identity,
      peers: [device.address],
    });

    again.sendText(wake(device, again, "d"));
    expect((await again.control("woken")).outcome).toBe("rate-limited");
  });

  test("the service's outcome reaches the host: an unregistered token says so", async () => {
    withService("unregistered", 410);
    const device = await identify();
    const host = await TestParty.connect(relay.url, "host", { peers: [device.address] });

    host.sendText(wake(device, host));
    expect((await host.control("woken")).outcome).toBe("unregistered");
  });

  test("a push service that can't be reached answers unavailable", async () => {
    // Nothing listens on port 1.
    relay = startTestRelay({ push: { url: "http://127.0.0.1:1/api/push", secret: SECRET } });
    const device = await identify();
    const host = await TestParty.connect(relay.url, "host", { peers: [device.address] });

    host.sendText(wake(device, host));
    expect((await host.control("woken")).outcome).toBe("unavailable");
  });

  test("a relay without a push service says so in its challenge and answers unavailable", async () => {
    relay = startTestRelay();
    const device = await identify();
    const party = await TestParty.connect(relay.url, "host", { peers: [device.address] });
    // authenticate consumed the challenge; it is kept in what the party received.
    expect(challengeOf(party)?.push).toBe(false);

    party.sendText(wake(device, party));
    expect((await party.control("woken")).outcome).toBe("unavailable");
  });
});
