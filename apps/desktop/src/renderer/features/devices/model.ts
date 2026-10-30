/**
 * Settings → Devices, pure (Paper D1, D1b; ENG-461): each Host's Relay route and
 * Linked Devices, folded into one row per device across Hosts (by its Noise key).
 */
import { Match } from "effect";
import type { LinkedDeviceView, RelayRouteView } from "../../../shared/linkedDevicesContract.ts";
import { timeAgo } from "../settings/model/github.ts";

export const CAPABILITY = "linked-devices";

/** `devices.watch` and each device's `connectedSince` (ENG-629). */
export const PRESENCE_CAPABILITY = "linked-devices.presence";

/** One Host as the page sees it, in the Host list's order. */
export type HostRelay = {
  readonly key: string;
  readonly label: string;
} & (
  | { readonly kind: "offline"; readonly state: string }
  | { readonly kind: "unsupported" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly route: RelayRouteView;
      readonly devices: ReadonlyArray<LinkedDeviceView>;
    }
);

type Ready = Extract<HostRelay, { kind: "ready" }>;

export interface DeviceSummary {
  readonly noiseKey: string;
  readonly relayAddress: LinkedDeviceView["relayAddress"];
  readonly name: string;
  /** When the first Host linked it. */
  readonly linkedAt: string;
  /** The latest session it opened with any Host; null when it hasn't yet. */
  readonly lastSeenAt: string | null;
  /** Each Host it is linked on, with that Host's id for it, its last session and its presence. */
  readonly on: ReadonlyArray<{
    readonly hostKey: string;
    readonly id: LinkedDeviceView["id"];
    readonly lastUsedAt: string | null;
    /** When its open session there began, null without one; absent from older Daemons. */
    readonly connectedSince?: string | null | undefined;
  }>;
  /** Hosts with the relay on that don't have it: "Retry" shares it there. */
  readonly notShared: ReadonlyArray<{ readonly key: string; readonly label: string }>;
}

const later = (a: string | null, b: string | null) =>
  a === null ? b : b === null ? a : a > b ? a : b;

/** A Host with the route on and a relay URL takes linked devices. */
export const takesDevices = (host: HostRelay): host is Ready =>
  host.kind === "ready" && host.route.state === "on" && host.route.url !== null;

/** Linked devices across Hosts, oldest link first; unlinked ones are gone from Settings. */
export const devicesOf = (hosts: ReadonlyArray<HostRelay>): ReadonlyArray<DeviceSummary> => {
  const ready = hosts.filter((h): h is Ready => h.kind === "ready");
  const byKey = new Map<string, DeviceSummary>();

  for (const host of ready) {
    for (const device of host.devices) {
      if (device.unlinkedAt !== null) continue;

      const seen = byKey.get(device.noiseKey);

      byKey.set(device.noiseKey, {
        noiseKey: device.noiseKey,
        relayAddress: device.relayAddress,
        name: seen?.name ?? device.name,
        linkedAt:
          seen === undefined || device.createdAt < seen.linkedAt ? device.createdAt : seen.linkedAt,
        lastSeenAt: later(seen?.lastSeenAt ?? null, device.lastUsedAt),
        on: [
          ...(seen?.on ?? []),
          {
            hostKey: host.key,
            id: device.id,
            lastUsedAt: device.lastUsedAt,
            connectedSince: device.connectedSince,
          },
        ],
        notShared: [],
      });
    }
  }

  return [...byKey.values()]
    .map((device) => ({
      ...device,
      notShared: hosts.flatMap((h) =>
        takesDevices(h) && !device.on.some((o) => o.hostKey === h.key)
          ? [{ key: h.key, label: h.label }]
          : []
      ),
    }))
    .toSorted((a, b) => a.linkedAt.localeCompare(b.linkedAt));
};

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

const hosts = (n: number) => `${n} host${n === 1 ? "" : "s"}`;

/** "A", "A and B", "A, B and C". */
export const names = (labels: ReadonlyArray<string>) =>
  labels.length <= 2
    ? labels.join(" and ")
    : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;

/** "Linked Oct 20 · on 3 hosts", or "… · on 2 of 3 hosts · not shared with Raspberry Pi 4". */
export const sharedLine = (device: DeviceSummary): string => {
  const linked = `Linked ${day(device.linkedAt)}`;

  if (device.notShared.length === 0) return `${linked} · on ${hosts(device.on.length)}`;

  const total = device.on.length + device.notShared.length;

  return `${linked} · on ${device.on.length} of ${hosts(total)} · not shared with ${names(device.notShared.map((h) => h.label))}`;
};

/** "last seen 4 minutes ago", "not seen yet". */
export const lastSeenLine = (device: DeviceSummary, now: number): string =>
  device.lastSeenAt === null
    ? "not seen yet"
    : `last seen ${timeAgo(now - Date.parse(device.lastSeenAt))}`;

/** A row's caption: "Linked Oct 20 · last seen 4 minutes ago", or where it isn't shared yet. */
export const deviceCaption = (device: DeviceSummary, now: number): string =>
  device.notShared.length > 0
    ? sharedLine(device)
    : `Linked ${day(device.linkedAt)} · ${lastSeenLine(device, now)}`;

/** For Daemons without presence: how recently a device must have opened a session to count. */
export const LIVE_WINDOW_MS = 5 * 60_000;

const recentlyUsed = (lastUsedAt: string | null, now: number) =>
  lastUsedAt !== null && now - Date.parse(lastUsedAt) <= LIVE_WINDOW_MS;

/**
 * Whether the device is connected to `host` now: its relay is connected and the device has a
 * session open there (ENG-629); an older Daemon's device, one opened within LIVE_WINDOW_MS.
 */
export const liveOn = (
  host: HostRelay,
  on: DeviceSummary["on"][number] | undefined,
  now: number
): boolean =>
  takesDevices(host) &&
  host.route.connected &&
  on !== undefined &&
  (on.connectedSince === undefined ? recentlyUsed(on.lastUsedAt, now) : on.connectedSince !== null);

/** The relay lane of "Hosts your devices reach". `action` is "Turn on" when the user can. */
export const relayLine = (
  host: HostRelay
): { readonly text: string; readonly live: boolean; readonly action: boolean } =>
  Match.value(host).pipe(
    Match.discriminatorsExhaustive("kind")({
      offline: ({ state }) => ({
        text: `Host ${state.replace("-", " ")}`,
        live: false,
        action: false,
      }),
      unsupported: () => ({ text: "Daemon too old · upgrade it", live: false, action: false }),
      loading: () => ({ text: "Checking…", live: false, action: false }),
      failed: ({ message }) => ({ text: message, live: false, action: false }),
      ready: ({ route }) =>
        route.state === "off"
          ? { text: "Relay off", live: false, action: true }
          : route.connected
            ? { text: "Relay connected", live: true, action: false }
            : { text: "Relay connecting", live: false, action: false },
    })
  );

/** "4:32 left" until `expiresAt`. */
export const timeLeft = (expiresAt: string, now: number): string => {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} left`;
};
