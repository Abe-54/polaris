import { describe, expect, test } from "bun:test";
import type { LinkedDeviceView } from "../../../shared/linkedDevicesContract.ts";
import { noiseKey, phone, route } from "./fixture.testing.ts";
import { devicesOf, type HostRelay } from "./model.ts";
import {
  deviceNodes,
  flowingSegments,
  hostCurve,
  hostNodes,
  keyframes,
  MAX_PACKETS,
  PACKETS_PER_SEGMENT,
  reachLine,
  track,
} from "./reach.ts";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");

const FRESH = new Date(NOW - 60_000).toISOString();

const STALE = new Date(NOW - 2 * 86_400_000).toISOString();

const host = async (
  key: string,
  devices: ReadonlyArray<LinkedDeviceView>,
  state: "on" | "off" = "on",
  connected = state === "on"
): Promise<HostRelay> => ({
  key,
  label: key,
  kind: "ready",
  route: await route(state, connected),
  devices,
});

describe("packets run only on live routes", () => {
  test("a live route flows on both of its segments; connecting, off and away stay still", async () => {
    const live = noiseKey();
    const away = noiseKey();

    const hosts = [
      await host("studio", [
        await phone({ noiseKey: live, lastUsedAt: FRESH }),
        await phone({ noiseKey: away, name: "iPad mini", lastUsedAt: STALE }),
      ]),
      await host("vm", [await phone({ noiseKey: live, lastUsedAt: FRESH })], "on", false),
      await host("pi", [await phone({ noiseKey: live, lastUsedAt: FRESH })], "off"),
    ];

    const devices = devicesOf(hosts);

    expect(flowingSegments(hosts, devices, NOW)).toEqual([
      { kind: "host", key: "studio" },
      { kind: "device", key: live },
    ]);
    expect(hostNodes(hosts).map((h) => [h.key, h.line, h.word])).toEqual([
      ["studio", "live", "on"],
      ["vm", "connecting", "connecting"],
      ["pi", "faint", null],
    ]);
    expect(deviceNodes(hosts, devices, NOW).map((d) => [d.name, d.line, d.age])).toEqual([
      ["Lucas's iPhone", "live", "1m"],
      ["iPad mini", "away", "2d"],
    ]);
    expect(reachLine(hosts, devices, NOW)).toBe("1 device live, through 1 of 3 hosts");
  });

  test("a host whose devices are all away keeps its solid line but carries nothing", async () => {
    const hosts = [
      await host("studio", [await phone({ noiseKey: noiseKey(), lastUsedAt: STALE })]),
    ];

    const devices = devicesOf(hosts);

    expect(hostNodes(hosts)[0]?.line).toBe("live");
    expect(flowingSegments(hosts, devices, NOW)).toEqual([]);
    expect(reachLine(hosts, devices, NOW)).toBe("No device live right now");
  });

  test(`the map never carries more than ${MAX_PACKETS} packets`, async () => {
    const keys = Array.from({ length: 6 }, () => noiseKey());

    const hosts = await Promise.all(
      Array.from({ length: 6 }, async (_, i) =>
        host(
          `host-${i}`,
          await Promise.all(keys.map((k) => phone({ noiseKey: k, lastUsedAt: FRESH })))
        )
      )
    );

    const packets = flowingSegments(hosts, devicesOf(hosts), NOW).length * PACKETS_PER_SEGMENT;

    expect(packets).toBeLessThanOrEqual(MAX_PACKETS);
    expect(packets).toBeGreaterThan(MAX_PACKETS - 2 * PACKETS_PER_SEGMENT);
  });
});

describe("a packet's path", () => {
  const curve = hostCurve(52, 842, 216);

  test("steps are even along the curve, so the linear crossing keeps one speed", () => {
    const { points, length } = track(curve);

    const steps = points.slice(1).map(([x, y], i) => {
      const [px, py] = points[i] ?? [x, y];

      return Math.hypot(x - px, y - py);
    });

    for (const step of steps) expect(step).toBeCloseTo(length / steps.length, 0);
    expect(points[0]).toEqual([462, 108]);
    expect(points.at(-1)?.map((n) => Math.round(n))).toEqual([624, 52]);
  });

  test("it fades in over the first 10% and out over the last 10%, and the trail is at 40%", () => {
    const { points } = track(curve);
    const head = keyframes(points, 4, 1);
    const trail = keyframes(points, 2, 0.4);

    const opacity = (frames: ReadonlyArray<Keyframe>, offset: number) =>
      frames.find((f) => Math.abs((f.offset ?? -1) - offset) < 1e-9)?.opacity;

    const expected = [0, 0.5, 1, 1, 1, 0.5, 0];

    [0, 0.05, 0.1, 0.5, 0.9, 0.95, 1].forEach((offset, i) =>
      expect(opacity(head, offset)).toBeCloseTo(expected[i] ?? -1, 9)
    );
    expect(opacity(trail, 0.5)).toBeCloseTo(0.4, 9);
    expect(
      head.every((f) => Object.keys(f).every((k) => ["offset", "transform", "opacity"].includes(k)))
    ).toBe(true);
  });
});
