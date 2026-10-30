/**
 * The reach map, pure (DESIGN.md SR-08, rule/reach-flow-is-the-only-other-loop; Paper "SR-08 ·
 * Reach flow"): where the devices, the Polaris Relay and the hosts sit, each line's style, and
 * which segments carry packets.
 */
import { Match } from "effect";
import { type DeviceSummary, type HostRelay, liveOn } from "./model.ts";

/** Live is solid, connecting dashed; relay off, host offline or not answering is faint. */
export type HostLine = "live" | "connecting" | "faint";

/** A device away from every live host is a faint line. */
export type DeviceLine = "live" | "away";

export interface HostNode {
  readonly key: string;
  readonly label: string;
  readonly line: HostLine;
  /** The mono state word ("on", "connecting"); null when the chip offers "Turn on" instead. */
  readonly word: string | null;
}

export interface DeviceNode {
  readonly key: string;
  readonly name: string;
  readonly line: DeviceLine;
  /** Since it last opened a session: "4m", "2d"; "new" before it has. */
  readonly age: string;
}

export type Segment =
  | { readonly kind: "host"; readonly key: string }
  | { readonly kind: "device"; readonly key: string };

export const PACKETS_PER_SEGMENT = 3;

/** The whole map's packet budget. */
export const MAX_PACKETS = 24;

/** One crossing of a segment, linear. */
export const LOOP_MS = 1600;

const hostWord = (host: HostRelay): Pick<HostNode, "line" | "word"> =>
  Match.value(host).pipe(
    Match.discriminatorsExhaustive("kind")({
      offline: ({ state }) => ({ line: "faint" as const, word: state.replace("-", " ") }),
      unsupported: () => ({ line: "faint" as const, word: "too old" }),
      loading: () => ({ line: "faint" as const, word: "checking" }),
      failed: () => ({ line: "faint" as const, word: "failed" }),
      ready: ({ route }) =>
        route.state === "off"
          ? { line: "faint" as const, word: null }
          : route.connected
            ? { line: "live" as const, word: "on" }
            : { line: "connecting" as const, word: "connecting" },
    })
  );

export const hostNodes = (hosts: ReadonlyArray<HostRelay>): ReadonlyArray<HostNode> =>
  hosts.map((host) => ({ key: host.key, label: host.label, ...hostWord(host) }));

const age = (lastSeenAt: string | null, now: number): string => {
  if (lastSeenAt === null) return "new";

  const minutes = Math.max(0, Math.floor((now - Date.parse(lastSeenAt)) / 60_000));

  if (minutes < 60) return `${minutes}m`;

  return minutes < 24 * 60 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
};

/** Each live route: a host and a device connected through it now. */
const liveRoutes = (
  hosts: ReadonlyArray<HostRelay>,
  devices: ReadonlyArray<DeviceSummary>,
  now: number
) =>
  devices.flatMap((device) =>
    hosts.flatMap((host) =>
      liveOn(
        host,
        device.on.find((o) => o.hostKey === host.key),
        now
      )
        ? [{ host: host.key, device: device.noiseKey }]
        : []
    )
  );

export const deviceNodes = (
  hosts: ReadonlyArray<HostRelay>,
  devices: ReadonlyArray<DeviceSummary>,
  now: number
): ReadonlyArray<DeviceNode> => {
  const live = new Set(liveRoutes(hosts, devices, now).map((r) => r.device));

  return devices.map((device) => ({
    key: device.noiseKey,
    name: device.name,
    line: live.has(device.noiseKey) ? "live" : "away",
    age: age(device.lastSeenAt, now),
  }));
};

/** The segments that carry packets: only those on a live route, at most MAX_PACKETS in all. */
export const flowingSegments = (
  hosts: ReadonlyArray<HostRelay>,
  devices: ReadonlyArray<DeviceSummary>,
  now: number
): ReadonlyArray<Segment> => {
  const segments: Array<Segment> = [];
  const seen = new Set<string>();
  const budget = Math.floor(MAX_PACKETS / PACKETS_PER_SEGMENT);

  for (const route of liveRoutes(hosts, devices, now)) {
    const pair: ReadonlyArray<Segment> = [
      { kind: "host", key: route.host },
      { kind: "device", key: route.device },
    ];

    const next = pair.filter((s) => !seen.has(`${s.kind}:${s.key}`));

    if (segments.length + next.length > budget) break;

    for (const s of next) {
      seen.add(`${s.kind}:${s.key}`);
      segments.push(s);
    }
  }

  return segments;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The map's aside: "1 device live, through 1 of 3 hosts". */
export const reachLine = (
  hosts: ReadonlyArray<HostRelay>,
  devices: ReadonlyArray<DeviceSummary>,
  now: number
): string => {
  if (devices.length === 0) return "No linked devices";

  const routes = liveRoutes(hosts, devices, now);
  const live = new Set(routes.map((r) => r.device)).size;

  if (live === 0) return "No device live right now";

  const through = new Set(routes.map((r) => r.host)).size;

  return `${plural(live, "device")} live, through ${through} of ${plural(hosts.length, "host")}`;
};

export type Point = readonly [number, number];

export type Cubic = readonly [Point, Point, Point, Point];

/** Paper SR-08's geometry, in px. */
export const MAP = {
  pad: 24,
  deviceW: 192,
  hostW: 194,
  chipH: 36,
  relayW: 82,
  relayH: 48,
  hostPitch: 56,
  devicePitch: 76,
  minH: 216,
  margin: 34,
} as const;

const span = (n: number, pitch: number) => (n === 0 ? 0 : (n - 1) * pitch + MAP.chipH);

export const mapHeight = (hosts: number, devices: number): number =>
  Math.max(
    MAP.minH,
    Math.max(span(hosts, MAP.hostPitch), span(devices, MAP.devicePitch)) + 2 * MAP.margin
  );

/** The centre line of the i-th of n chips in a column. */
export const rowCentre = (i: number, n: number, pitch: number, height: number): number =>
  height / 2 - ((n - 1) * pitch) / 2 + i * pitch;

export const relayLeft = (width: number): number => (width - MAP.relayW) / 2;

export const hostLeft = (width: number): number => width - MAP.pad - MAP.hostW;

/** From a device chip's right edge into the relay. */
export const deviceCurve = (cy: number, width: number, height: number): Cubic => {
  const x0 = MAP.pad + MAP.deviceW;
  const x1 = relayLeft(width);

  return [
    [x0, cy],
    [x0 + 84, cy],
    [x1 - 60, height / 2],
    [x1, height / 2],
  ];
};

/** From the relay's right edge into a host chip. */
export const hostCurve = (cy: number, width: number, height: number): Cubic => {
  const x0 = relayLeft(width) + MAP.relayW;
  const x1 = hostLeft(width);

  return [
    [x0, height / 2],
    [x0 + 78, height / 2],
    [x1 - 64, cy],
    [x1, cy],
  ];
};

export const pathOf = ([a, b, c, d]: Cubic): string =>
  `M${a[0]} ${a[1]}C${b[0]} ${b[1]} ${c[0]} ${c[1]} ${d[0]} ${d[1]}`;

export const reversed = ([a, b, c, d]: Cubic): Cubic => [d, c, b, a];

const at = ([a, b, c, d]: Cubic, t: number): Point => {
  const u = 1 - t;
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t] as const;

  return [
    w[0] * a[0] + w[1] * b[0] + w[2] * c[0] + w[3] * d[0],
    w[0] * a[1] + w[1] * b[1] + w[2] * c[1] + w[3] * d[1],
  ];
};

/** `count + 1` points evenly spaced along the curve's length, and that length. */
export interface Track {
  readonly points: ReadonlyArray<Point>;
  readonly length: number;
}

export const track = (curve: Cubic, count = 20): Track => {
  const dense = Array.from({ length: 129 }, (_, i) => at(curve, i / 128));
  const lengths = [0];

  for (let i = 1; i < dense.length; i++) {
    const [x0, y0] = dense[i - 1] ?? [0, 0];
    const [x1, y1] = dense[i] ?? [0, 0];
    lengths.push((lengths[i - 1] ?? 0) + Math.hypot(x1 - x0, y1 - y0));
  }

  const length = lengths.at(-1) ?? 0;
  let j = 0;

  const points = Array.from({ length: count + 1 }, (_, k): Point => {
    const target = (k / count) * length;

    while (j < lengths.length - 2 && (lengths[j + 1] ?? 0) < target) j++;

    const from = lengths[j] ?? 0;
    const to = lengths[j + 1] ?? from;
    const f = to === from ? 0 : (target - from) / (to - from);
    const [x0, y0] = dense[j] ?? [0, 0];
    const [x1, y1] = dense[j + 1] ?? [x0, y0];

    return [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f];
  });

  return { points, length };
};

/** Fades in over the first 10% of the crossing and out over the last 10%. */
export const fade = (offset: number): number =>
  Math.max(0, Math.min(1, offset * 10, (1 - offset) * 10));

/** Keyframes for a square of `size` px moving along `points`, at `alpha` of full opacity. */
export const keyframes = (
  points: ReadonlyArray<Point>,
  size: number,
  alpha: number
): Array<Keyframe> =>
  points.map(([x, y], i) => {
    const offset = i / (points.length - 1);

    return {
      offset,
      transform: `translate(${x - size / 2}px, ${y - size / 2}px)`,
      opacity: fade(offset) * alpha,
    };
  });
