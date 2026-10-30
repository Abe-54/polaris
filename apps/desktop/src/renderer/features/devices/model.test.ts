import { describe, expect, test } from "bun:test";
import type { LinkedDeviceView } from "../../../shared/linkedDevicesContract.ts";
import { noiseKey, phone, route } from "./fixture.testing.ts";
import {
  devicesOf,
  type HostRelay,
  lastSeenLine,
  liveOn,
  relayLine,
  sharedLine,
  timeLeft,
} from "./model.ts";

const ready = async (
  key: string,
  label: string,
  devices: ReadonlyArray<LinkedDeviceView>,
  state: "on" | "off" = "on"
): Promise<HostRelay> => ({ key, label, kind: "ready", route: await route(state), devices });

describe("linked devices across hosts", () => {
  test("one phone on two hosts is one row, with the host it missed and its latest use", async () => {
    const iphone = noiseKey();

    const hosts = [
      await ready("studio", "Mac Studio", [
        await phone({ noiseKey: iphone, lastUsedAt: "2026-10-27T11:56:00.000Z" }),
      ]),
      await ready("pi", "Raspberry Pi 4", []),
      await ready("mbp", "MacBook Pro", [
        await phone({
          noiseKey: iphone,
          createdAt: "2026-10-21T09:00:00.000Z",
          lastUsedAt: "2026-10-26T08:00:00.000Z",
        }),
      ]),
      await ready("vm", "Linux VM", [], "off"),
    ];

    const [device, ...rest] = devicesOf(hosts);

    expect(rest).toEqual([]);
    expect(device?.on.map((o) => o.hostKey)).toEqual(["studio", "mbp"]);
    expect(device === undefined ? "" : sharedLine(device)).toBe(
      "Linked Oct 20 · on 2 of 3 hosts · not shared with Raspberry Pi 4"
    );
    expect(
      device === undefined ? "" : lastSeenLine(device, Date.parse("2026-10-27T12:00:00.000Z"))
    ).toBe("last seen 4 minutes ago");
  });

  test("an unlinked device is gone, and one on every relay host says how many", async () => {
    const hosts = [
      await ready("studio", "Mac Studio", [
        await phone({ noiseKey: noiseKey(), unlinkedAt: "2026-10-22T00:00:00.000Z" }),
        await phone({ noiseKey: noiseKey(), name: "iPad" }),
      ]),
    ];

    const devices = devicesOf(hosts);

    expect(devices.map((d) => [d.name, sharedLine(d), lastSeenLine(d, 0)])).toEqual([
      ["iPad", "Linked Oct 20 · on 1 host", "not seen yet"],
    ]);
  });
});

describe("a host's relay line", () => {
  test.each([
    ["on and connected", "on", true, { text: "Relay connected", live: true, action: false }],
    [
      "on, not connected yet",
      "on",
      false,
      { text: "Relay connecting", live: false, action: false },
    ],
    ["off", "off", false, { text: "Relay off", live: false, action: true }],
  ] as const)("%s", async (_, state, connected, line) => {
    const host: HostRelay = {
      key: "k",
      label: "Mac Studio",
      kind: "ready",
      route: await route(state, connected),
      devices: [],
    };

    expect(relayLine(host)).toEqual(line);
  });
});

test("the link's countdown", () => {
  const expiresAt = "2026-10-27T12:05:00.000Z";

  expect(timeLeft(expiresAt, Date.parse("2026-10-27T12:00:28.000Z"))).toBe("4:32 left");
  expect(timeLeft(expiresAt, Date.parse("2026-10-27T12:06:00.000Z"))).toBe("0:00 left");
});

describe("a device counts as connected to a host by the Daemon's presence (ENG-629)", () => {
  const now = Date.parse("2026-10-27T12:00:00.000Z");
  const hourAgo = "2026-10-27T11:00:00.000Z";

  test.each([
    ["a session open for an hour", hourAgo, hourAgo, true, true],
    ["no session, though used a minute ago", null, "2026-10-27T11:59:00.000Z", true, false],
    ["a session open while the host's relay is disconnected", hourAgo, hourAgo, false, false],
  ] as const)("%s", async (_, connectedSince, lastUsedAt, connected, live) => {
    const host: HostRelay = {
      key: "studio",
      label: "Mac Studio",
      kind: "ready",
      route: await route("on", connected),
      devices: [],
    };

    const { id } = await phone({ noiseKey: noiseKey() });

    expect(liveOn(host, { hostKey: "studio", id, lastUsedAt, connectedSince }, now)).toBe(live);
  });
});

describe("a device counts as connected to a host on an older Daemon (stopgap)", () => {
  const now = Date.parse("2026-10-27T12:00:00.000Z");
  const at = (ms: number) => new Date(now - ms).toISOString();

  test.each([
    ["used exactly 5 minutes ago", 5 * 60_000, true, true],
    ["used 5 minutes and 1 ms ago", 5 * 60_000 + 1, true, false],
    ["used just now, relay still connecting", 0, false, false],
  ] as const)("%s", async (_, ago, connected, live) => {
    const host: HostRelay = {
      key: "studio",
      label: "Mac Studio",
      kind: "ready",
      route: await route("on", connected),
      devices: [],
    };

    expect(
      liveOn(
        host,
        { hostKey: "studio", id: (await phone({ noiseKey: noiseKey() })).id, lastUsedAt: at(ago) },
        now
      )
    ).toBe(live);
  });

  test("a device that never opened a session isn't connected", async () => {
    const host: HostRelay = {
      key: "studio",
      label: "Mac Studio",
      kind: "ready",
      route: await route("on"),
      devices: [],
    };

    const { id } = await phone({ noiseKey: noiseKey() });

    expect(liveOn(host, { hostKey: "studio", id, lastUsedAt: null }, now)).toBe(false);
  });
});
