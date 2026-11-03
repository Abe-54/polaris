/**
 * Hosts (Paper MX-AD, MX-AE) as data: instrument rows grouped "Needs a look" and "Connected",
 * and the host details sheet. Only what the Client knows today; routes are chosen on the Mac.
 */
import type { ConnectionState } from "@polaris/protocol";
import { Match } from "effect";
import { type DeviceCopy, deviceCopyFor } from "../app/deviceCopy.ts";
import type { HostRoute } from "../runtime/hostConnection.ts";
import { age, counted, grouped, shortHostName } from "../home/model/format.ts";

export interface HostInput {
  readonly hostId: string;
  readonly name: string;
  readonly route: HostRoute;
  readonly state: ConnectionState;
  /** The last failure's own line; it outlives the reconnect that follows it. */
  readonly failure: string | null;
  /** The round trip of the ping after hello (the client's `roundTrip`), in ms. */
  readonly latencyMs: number | null;
  /** The latest hello while connected, else when the connection dropped (ms since epoch). */
  readonly lastSeenAt: number | null;
  /** Listed agent sessions as last seen; null when never seen this launch. */
  readonly sessions: number | null;
}

export interface HostRowModel {
  readonly key: string;
  readonly name: string;
  readonly state: ConnectionState;
  /** "6 agent sessions", "Reconnecting · 42s", "Offline · last seen 3h ago". */
  readonly line: string;
  /** "4 ms", or "—" whenever the Host isn't connected. */
  readonly roundTrip: string;
  readonly route: string;
}

export interface HostSection {
  readonly title: "Needs a look" | "Connected";
  readonly rows: ReadonlyArray<HostRowModel>;
}

export interface HostsModel {
  /** "4 linked · 1 reconnecting · 1 offline". */
  readonly summary: string;
  readonly sections: ReadonlyArray<HostSection>;
}

export const routeLabel = (route: HostRoute): string =>
  Match.value(route).pipe(
    Match.when("relay", () => "via Polaris Relay"),
    Match.when("dev-bridge", () => "on this network"),
    Match.exhaustive
  );

/** "42s", "3m": how long a state has lasted. */
const elapsed = (since: number, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));

  return seconds < 60 ? `${seconds}s` : age(since, now);
};

/** "last seen 3h ago", or "last seen just now" inside the minute. */
const lastSeen = (at: number, now: number): string => {
  const ago = age(at, now);

  return ago === "now" ? "last seen just now" : `last seen ${ago} ago`;
};

/** "4 ms", and "12.3 s" once a round trip passes a second. */
const milliseconds = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;

const sessionsLine = (sessions: number | null) =>
  sessions === null ? "Connected" : counted(sessions, "agent session");

const rowLine = (host: HostInput, now: number): string =>
  Match.value(host.state).pipe(
    Match.when("connected", () => sessionsLine(host.sessions)),
    Match.when("reconnecting", () =>
      host.lastSeenAt === null ? "Reconnecting" : `Reconnecting · ${elapsed(host.lastSeenAt, now)}`
    ),
    Match.when("needs-attention", () => "Needs attention"),
    Match.when("offline", () =>
      host.lastSeenAt === null ? "Offline" : `Offline · ${lastSeen(host.lastSeenAt, now)}`
    ),
    Match.exhaustive
  );

const roundTrip = (host: HostInput): string =>
  host.state === "connected" && host.latencyMs !== null ? milliseconds(host.latencyMs) : "—";

/** Needs attention first: it waits on the user; reconnecting and offline wait on the network. */
const ORDER: Record<ConnectionState, number> = {
  "needs-attention": 0,
  reconnecting: 1,
  offline: 2,
  connected: 3,
};

const NOTED = ["needs-attention", "reconnecting", "offline"] as const;

export const buildHosts = (hosts: ReadonlyArray<HostInput>, now: number): HostsModel => {
  const rows = [...hosts]
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name))
    .map((host): HostRowModel => ({
      key: host.hostId,
      name: shortHostName(host.name),
      state: host.state,
      line: rowLine(host, now),
      roundTrip: roundTrip(host),
      route: routeLabel(host.route),
    }));

  const look = rows.filter((row) => row.state !== "connected");
  const connected = rows.filter((row) => row.state === "connected");

  const sections: ReadonlyArray<HostSection> = [
    ...(look.length === 0 ? [] : [{ title: "Needs a look" as const, rows: look }]),
    ...(connected.length === 0 ? [] : [{ title: "Connected" as const, rows: connected }]),
  ];

  const tallies = NOTED.flatMap((state) => {
    const count = hosts.filter((host) => host.state === state).length;

    return count === 0
      ? []
      : [`${count} ${state === "needs-attention" ? "needs attention" : state}`];
  });

  return {
    summary:
      hosts.length === 0
        ? "No hosts linked yet"
        : [`${hosts.length} linked`, ...tallies].join(" · "),
    sections,
  };
};

export interface HostDetails {
  readonly name: string;
  readonly state: ConnectionState;
  /** "Connected for 2h", "Reconnecting for 42s", "Offline · last seen 3h ago". */
  readonly status: string;
  readonly failure: string | null;
  readonly roundTrip: string;
  readonly route: string;
  /** "3", or "—" before this launch saw the Host's agent sessions. */
  readonly sessions: string;
  /** "Agent sessions", with "last known" once the Host isn't connected. */
  readonly sessionsLabel: string;
}

const since = (word: string, at: number | null, now: number) =>
  at === null ? word : `${word} for ${elapsed(at, now)}`;

const detailStatus = (host: HostInput, now: number): string =>
  Match.value(host.state).pipe(
    Match.when("connected", () => since("Connected", host.lastSeenAt, now)),
    Match.when("reconnecting", () => since("Reconnecting", host.lastSeenAt, now)),
    Match.when("needs-attention", () => "Needs attention"),
    Match.when("offline", () => rowLine(host, now)),
    Match.exhaustive
  );

/** The host details sheet (MX-AE): its Connection State and how long, then its readouts. */
export const hostDetails = (host: HostInput, now: number): HostDetails => ({
  name: host.name,
  state: host.state,
  status: detailStatus(host, now),
  failure: host.failure,
  roundTrip: roundTrip(host),
  route: routeLabel(host.route),
  sessions: host.sessions === null ? "—" : grouped(host.sessions),
  sessionsLabel:
    host.state === "connected" || host.sessions === null
      ? "Agent sessions"
      : "Agent sessions, last known",
});

/** What to say when Unlink left this iPhone trusted somewhere (RX1-3); null when it didn't. */
export const unlinkNote = (
  kept: ReadonlyArray<string>,
  { phone, computer }: DeviceCopy = deviceCopyFor("ios")
): string | null => {
  if (kept.length === 0) return null;
  const one = kept.length === 1;

  return `Still linked to ${kept.join(", ")}: ${one ? "it" : "they"} didn't answer. Unlink again when ${one ? "it's" : "they're"} online, or unlink this ${phone} on your ${computer} in Settings → Devices.`;
};
