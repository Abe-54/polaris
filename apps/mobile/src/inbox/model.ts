/**
 * The needs you inbox (Paper MX-H) as data: every Host's needs you rows in Home's order, so the
 * sheet and Home's hero card never disagree. Derived from the feeds, so a resolved request leaves it.
 */
import type { ConnectionState } from "@polaris/protocol";
import { counted, shortHostName } from "../home/model/format.ts";
import { buildHome, type HomeHost, type SessionRow } from "../home/model/home.ts";

export interface FooterHost {
  /** A Host's id, or "connected" for the folded connected Hosts. */
  readonly key: string;
  /** "2 connected", "lucas-rpi reconnecting". */
  readonly label: string;
  readonly connection: ConnectionState;
}

export interface Inbox {
  /** Oldest first across every Host, as on Home. */
  readonly items: ReadonlyArray<SessionRow>;
  readonly count: number;
  /** The empty state's second line ("4 sessions working on 2 hosts"); null when nothing works. */
  readonly working: string | null;
  /** Connected Hosts fold into one item; away Hosts are named, so their state never truncates. */
  readonly hosts: ReadonlyArray<FooterHost>;
  /** A request waits on a Host that is away: it can't be answered until the Host is back. */
  readonly away: boolean;
}

const stateWord: Record<ConnectionState, string> = {
  connected: "",
  reconnecting: " reconnecting",
  "needs-attention": " needs attention",
  offline: " offline",
};

const workingLine = (home: ReturnType<typeof buildHome>, hostCount: number) =>
  home.working === 0
    ? null
    : `${counted(home.working, "session")} working on ${counted(hostCount, "host")}`;

const footerOf = (hosts: ReadonlyArray<HomeHost>): ReadonlyArray<FooterHost> => {
  const named = (host: HomeHost): FooterHost => ({
    key: host.hostId,
    label: `${shortHostName(host.name)}${stateWord[host.connection]}`,
    connection: host.connection,
  });

  const connected = hosts.filter((host) => host.connection === "connected");
  const away = hosts.flatMap((host) => (host.connection === "connected" ? [] : [named(host)]));

  if (connected.length === 1 && away.length === 0) return connected.map(named);

  const fold: ReadonlyArray<FooterHost> =
    connected.length === 0
      ? []
      : [{ key: "connected", label: `${connected.length} connected`, connection: "connected" }];

  return [...fold, ...away];
};

export const inboxOf = (hosts: ReadonlyArray<HomeHost>): Inbox => {
  const home = buildHome(hosts, null);
  const items = home.sections.needsYou;
  const busyHosts = new Set(home.sections.working.map((row) => row.hostId));

  return {
    items,
    count: items.length,
    working: workingLine(home, Math.max(busyHosts.size, 1)),
    hosts: footerOf(hosts),
    away: items.some((row) => row.stale),
  };
};
