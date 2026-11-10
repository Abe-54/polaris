import { afterEach, describe, expect, test } from "bun:test";
import {
  encodeControl,
  LivePushRequest,
  PushHeaders,
  verifyPushRequest,
  type WakeOutcome,
} from "@polaris/protocol/relay";
import { signLiveTicket, signPushTicket } from "@polaris/protocol/relay/party";
import { Schema } from "effect";
import { TestParty } from "./testing/party.ts";
import {
  type Identified,
  identify,
  type RelayConfig,
  startTestRelay,
  type TestRelay,
} from "./testing/relay.ts";

const TOKEN = "b2".repeat(40);

const SECRET = "live-test-secret-0123456789abcdef0123";

const SLICE = "c2VhbGVkLXNsaWNlLXRoZS1yZWxheS1jYW5ub3QtcmVhZA";

const OTHER_SLICE = "YW5vdGhlci1ob3N0cy1zZWFsZWQtc2xpY2U";

const decodeLive = Schema.decodeUnknownSync(Schema.fromJsonString(LivePushRequest));

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
};

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
