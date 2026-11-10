import { afterEach, describe, expect, test } from "bun:test";
import {
  encodeControl,
  LivePushRequest,
  PushHeaders,
  RelayAddress,
  verifyPushRequest,
  type WakeOutcome,
} from "@polaris/protocol/relay";
import { signLiveTicket, signPushTicket } from "@polaris/protocol/relay/party";
import { Schema } from "effect";
import type { RelayConfig } from "./config.ts";
import { LiveActivities, type LivePut, mergeSlots } from "./live.ts";
import { TestParty } from "./testing/party.ts";
import { type Identified, identify, startTestRelay, type TestRelay } from "./testing/relay.ts";

const TOKEN = "b2".repeat(40);

const address = (n: number) =>
  Schema.decodeSync(RelayAddress)(`${String(n).padStart(2, "0")}${"A".repeat(20)}`);

const DEVICE = address(99);

const put = (host: number, slice: string, more: Partial<LivePut> = {}): LivePut => ({
  host: address(host),
  peer: DEVICE,
  token: TOKEN,
  environment: "sandbox",
  slice,
  active: false,
  alert: false,
  ...more,
});

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
};

/** LiveActivities with a 60 ms interval, recording what it asked the push service to send. */
const activities = (outcome: WakeOutcome = "sent", maxPerHost = 4) => {
  const sent: Array<LivePushRequest> = [];
  const gone: Array<{ hosts: ReadonlyArray<RelayAddress>; token: string }> = [];

  const live = new LiveActivities({
    deliver: async (request) => (sent.push(request), outcome),
    gone: (hosts, token) => gone.push({ hosts, token }),
    delivered: () => undefined,
    maxActivities: 10,
    maxPerHost,
    intervalMs: 60,
    hostGoneMs: 40,
  });

  return { live, sent, gone, slices: () => sent.map((r) => r.live.state.slices) };
};

describe("merging", () => {
  test("slices go by host address, and past six the hosts with work or Needs You stay", () => {
    const slots = new Map(
      [7, 3, 5, 1, 6, 2, 4].map((n) => [
        address(n),
        { peer: DEVICE, slice: `s${n}`, active: n > 3 },
      ])
    );

    expect(mergeSlots(new Map([...slots].slice(0, 3)))).toEqual(["s3", "s5", "s7"]);
    expect(mergeSlots(slots)).toEqual(["s1", "s2", "s4", "s5", "s6", "s7"]);
  });
});

describe("coalescing", () => {
  test("the first slice goes at once; later ones in the interval go together, latest per host", async () => {
    const { live, slices } = activities();

    live.put(put(1, "a1"));
    live.put(put(2, "b1"));
    live.put(put(1, "a2"));
    expect(slices()).toEqual([["a1"]]);

    await until(() => slices().length === 2);
    await Bun.sleep(80);
    expect(slices()).toEqual([["a1"], ["a2", "b1"]]);
    live.stop();
  });

  test("a new Needs You goes at once with the alert, even inside the interval", () => {
    const { live, sent } = activities();

    live.put(put(1, "a1"));
    live.put(put(2, "b1", { alert: true, active: true }));

    expect(sent.map((r) => [r.live.alert, r.live.state.slices])).toEqual([
      [false, ["a1"]],
      [true, ["a1", "b1"]],
    ]);
    live.stop();
  });
});

describe("dropping", () => {
  test("a host that stops listing the device leaves its activity; the update goes without it", async () => {
    const { live, slices } = activities();

    live.put(put(1, "a1"));
    live.put(put(2, "b1"));
    live.unlisted(address(1), new Set());
    await until(() => slices().length === 2);
    expect(slices().at(-1)).toEqual(["b1"]);

    live.unlisted(address(2), new Set([DEVICE]));
    live.put(put(2, "b1", { slice: null }));
    expect(live.size).toBe(0);
    live.stop();
  });

  test("a host whose socket stays gone leaves its activities; one that comes back keeps its slice", async () => {
    const { live, slices } = activities();

    live.put(put(1, "a1", { active: true }));
    live.put(put(2, "b1", { active: true }));
    live.hostGone(address(1));
    live.hostGone(address(2));
    live.hostBack(address(2));
    await until(() => slices().length === 2);

    expect(slices()).toEqual([["a1"], ["b1"]]);
    live.hostGone(address(2));
    await until(() => live.size === 0);
    expect(live.size).toBe(0);
    live.stop();
  });

  test("an unregistered token ends the activity and tells every host in it", async () => {
    const { live, gone } = activities("unregistered");

    live.put(put(1, "a1"));
    live.put(put(2, "b1", { alert: true }));
    await until(() => gone.length > 0);

    expect(gone[0]?.hosts).toEqual([address(1), address(2)]);
    expect(live.size).toBe(0);
    live.stop();
  });

  test("another device's ticket for the same token is another activity: it can't join or evict this one", async () => {
    const { live, slices } = activities();

    live.put(put(1, "mine"));
    live.put(put(2, "theirs", { peer: address(98), alert: true }));
    live.put(put(1, "mine", { peer: address(98), slice: null }));
    await Bun.sleep(80);

    expect(slices()).toEqual([["mine"], ["theirs"]]);
    expect(live.size).toBe(2);
    live.stop();
  });

  test("a host holds slices in at most its share of activities", () => {
    const { live, sent } = activities("sent", 1);

    live.put(put(1, "a1"));
    live.put(put(1, "x1", { token: "c3".repeat(40) }));

    expect(sent.map((r) => r.token)).toEqual([TOKEN]);
    live.stop();
  });
});

const SECRET = "live-test-secret-0123456789abcdef0123";

const SLICE = "c2VhbGVkLXNsaWNlLXRoZS1yZWxheS1jYW5ub3QtcmVhZA";

const OTHER_SLICE = "YW5vdGhlci1ob3N0cy1zZWFsZWQtc2xpY2U";

const decodeLive = Schema.decodeUnknownSync(Schema.fromJsonString(LivePushRequest));

describe("through the relay", () => {
  let relay: TestRelay;
  let service: ReturnType<typeof Bun.serve> | null = null;

  afterEach(async () => {
    void service?.stop(true);
    service = null;
    await relay.stop();
  });

  const withService = (outcome: WakeOutcome, config: Partial<RelayConfig> = {}) => {
    const received: Array<{ body: LivePushRequest; verified: boolean }> = [];

    service = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const body = await request.text();
        const header = (name: string) => request.headers.get(name) ?? "";

        const verified = await verifyPushRequest(
          SECRET,
          {
            method: "POST",
            path: new URL(request.url).pathname,
            timestamp: header(PushHeaders.timestamp),
            nonce: header(PushHeaders.nonce),
            body,
          },
          header(PushHeaders.signature)
        );

        received.push({ body: decodeLive(body), verified });

        return Response.json({ outcome }, { status: outcome === "unregistered" ? 410 : 200 });
      },
    });

    relay = startTestRelay({
      push: { url: `http://127.0.0.1:${service.port}/api/push`, secret: SECRET },
      ...config,
    });

    return received;
  };

  const frame = (
    device: Identified,
    host: TestParty,
    ticket = signLiveTicket,
    more: { readonly slice?: string; readonly alert?: boolean } = {}
  ) =>
    encodeControl({
      t: "live",
      peer: device.address,
      token: TOKEN,
      environment: "sandbox",
      ticket: ticket(device.identity, host.address ?? device.address, "sandbox", TOKEN),
      slice: SLICE,
      active: true,
      alert: false,
      ...more,
    });

  test("a host's slice reaches the push service as a signed liveactivity request, and the logs nothing", async () => {
    const received = withService("sent");
    const device = await identify();
    const host = await TestParty.connect(relay.url, "host", { peers: [device.address] });

    host.sendText(frame(device, host));
    await until(() => received.length > 0);
    const sentAt = received[0]?.body.live.timestamp ?? 0;

    expect(Math.abs(sentAt - Date.now() / 1000)).toBeLessThan(5);
    expect(received).toEqual([
      {
        body: {
          token: TOKEN,
          environment: "sandbox",
          live: {
            event: "update",
            timestamp: received[0]?.body.live.timestamp ?? 0,
            state: { v: 1, slices: [SLICE] },
            alert: false,
          },
        },
        verified: true,
      },
    ]);
    await host.close();
    const logged = JSON.stringify(relay.events);

    for (const secret of [TOKEN, SLICE, ...device.secrets]) expect(logged).not.toContain(secret);
  });

  test("a host that disconnects leaves the activity after the grace; the next update goes without it", async () => {
    const received = withService("sent", { liveHostGoneMs: 0 });
    const device = await identify();
    const gone = await TestParty.connect(relay.url, "host", { peers: [device.address] });
    const stays = await TestParty.connect(relay.url, "host", { peers: [device.address] });

    gone.sendText(frame(device, gone));
    await until(() => received.length > 0);
    await gone.close();
    // The relay logs the closed connection after it starts the host's (here 0 ms) grace.
    await until(() => relay.events.some((e) => e.event === "relay.connection"));
    await Bun.sleep(10);
    stays.sendText(frame(device, stays, signLiveTicket, { slice: OTHER_SLICE, alert: true }));
    await until(() => received.length > 1);

    expect(received.map(({ body }) => body.live.state.slices)).toEqual([[SLICE], [OTHER_SLICE]]);
    await stays.close();
  });

  test("a push ticket isn't a live ticket: the host hears live-gone and nothing is sent", async () => {
    const received = withService("sent");
    const device = await identify();
    const host = await TestParty.connect(relay.url, "host", { peers: [device.address] });

    host.sendText(frame(device, host, signPushTicket));

    expect(await host.control("live-gone")).toEqual({
      t: "live-gone",
      token: TOKEN,
      outcome: "unlinked",
    });
    expect(received).toEqual([]);
    await host.close();
  });

  test("when APNs no longer knows the token, every host in the activity hears live-gone", async () => {
    withService("unregistered");
    const device = await identify();
    const studio = await TestParty.connect(relay.url, "host", { peers: [device.address] });
    const laptop = await TestParty.connect(relay.url, "host", { peers: [device.address] });

    studio.sendText(frame(device, studio));
    laptop.sendText(frame(device, laptop));

    expect((await studio.control("live-gone")).outcome).toBe("unregistered");
    expect((await laptop.control("live-gone")).outcome).toBe("unregistered");
    await Promise.all([studio.close(), laptop.close()]);
  });
});
