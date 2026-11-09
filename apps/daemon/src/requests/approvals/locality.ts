/** An origin's locality for an agent's Send (ADR 0098): loopback without a tunnel is Local. */
import { createConnection } from "node:net";
import { basename } from "node:path";
import type { OriginLocality as Locality } from "@polaris/protocol";
import { localHost } from "../../data/connection.ts";
import { listenerOwners, type ListenerAddress, type Owner } from "../../data/listener.ts";

type OriginLocality = typeof Locality.Type;

export type OwnerLookup = (address: ListenerAddress) => Promise<ReadonlyArray<Owner>>;

/** A TCP connect to one loopback address: `unknown` for a timeout or any other error. */
export type ConnectProbe = (
  host: string,
  port: number
) => Promise<"refused" | "accepted" | "unknown">;

export interface LocalityProbes {
  readonly owners?: OwnerLookup;
  readonly connect?: ConnectProbe;
  readonly platform?: NodeJS.Platform;
}

export const tcpConnect: ConnectProbe = (host, port) =>
  new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: 500 });

    const done = (result: "refused" | "accepted" | "unknown") => {
      socket.destroy();
      resolve(result);
    };

    socket.once("connect", () => done("accepted"));
    socket.once("timeout", () => done("unknown"));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      done(error.code === "ECONNREFUSED" ? "refused" : "unknown")
    );
  });

/**
 * Processes that put another machine's service on a loopback port. Matched against the
 * listener's executable name, lowercased and without `.exe`.
 */
export const TUNNEL_EXECUTABLES: ReadonlySet<string> = new Set([
  "cloudflared",
  "ngrok",
  "ssh",
  "autossh",
  "sshuttle",
  "tailscale",
  "tailscaled",
  "kubectl",
  "kubefwd",
  "oc",
  "flyctl",
  "fly",
  "bore",
  "frpc",
  "inlets",
  "zrok",
  "localtunnel",
  "lt",
  "devtunnel",
  "tsh",
  "teleport",
  "cloud-sql-proxy",
  "cloud_sql_proxy",
  "gcloud",
  "session-manager-plugin",
  "aws",
  "az",
  "socat",
]);

export interface ParsedOrigin {
  /** `scheme://host:port`, the port always explicit. */
  readonly origin: string;
  readonly hostname: string;
  readonly port: number;
  readonly path: string;
}

/** The URL's origin, or undefined when it isn't an absolute http(s) URL. */
export const parseOrigin = (url: string): ParsedOrigin | undefined => {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  const port = parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port);

  return {
    origin: `${parsed.protocol}//${parsed.hostname}:${port}`,
    hostname: parsed.hostname,
    port,
    path: `${parsed.pathname}${parsed.search}`,
  };
};

const executableName = (owner: Owner) =>
  basename(owner.executable.replaceAll("\\", "/"))
    .toLowerCase()
    .replace(/\.exe$/, "");

/** Remote unless every listener on the loopback port is a known, non-tunnel process. */
export const ownersLocality = (owners: ReadonlyArray<Owner>): OriginLocality => {
  if (!owners.length) return "remote";

  return owners.every((owner) => {
    const name = executableName(owner);

    return name !== "" && !TUNNEL_EXECUTABLES.has(name);
  })
    ? "local"
    : "remote";
};

const plainHost = (hostname: string) => hostname.replace(/^\[|\]$/g, "").toLowerCase();

/** `*.localhost` names resolve to loopback (RFC 6761); Data's `localHost` leaves them out. */
const subLocalhost = (hostname: string) => plainHost(hostname).endsWith(".localhost");

/** The loopback addresses a name reaches: both families for `localhost` names. */
const loopbackAddresses = (hostname: string) => {
  const plain = plainHost(hostname);

  return plain === "localhost" || subLocalhost(plain) ? ["127.0.0.1", "::1"] : [plain];
};

/** Nothing listening: the Send can't leave the Host, so it's Local and fails as refused. */
const refusedEverywhere = async (hostname: string, port: number, connect: ConnectProbe) =>
  (
    await Promise.all(
      loopbackAddresses(hostname).map((host) => connect(host, port).catch(() => "unknown"))
    )
  ).every((result) => result === "refused");

/** A listener whose owner can't be verified (another user's, or on Windows) stays Remote. */
export const originLocality = async (
  origin: Pick<ParsedOrigin, "hostname" | "port">,
  probes: LocalityProbes = {}
): Promise<OriginLocality> => {
  const { owners = listenerOwners, connect = tcpConnect, platform = process.platform } = probes;

  if (!localHost(origin.hostname) && !subLocalhost(origin.hostname)) return "remote";

  if (platform === "win32") return "remote";

  const hostname = subLocalhost(origin.hostname) ? "127.0.0.1" : origin.hostname;
  const found = await owners({ hostname, port: origin.port }).catch(() => []);

  if (found.length) return ownersLocality(found);

  return (await refusedEverywhere(origin.hostname, origin.port, connect)) ? "local" : "remote";
};
