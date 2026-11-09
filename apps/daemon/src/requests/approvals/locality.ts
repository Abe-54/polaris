/** An origin's locality for an agent's Send (ADR 0098): loopback without a tunnel is Local. */
import { basename } from "node:path";
import type { OriginLocality as Locality } from "@polaris/protocol";
import { localHost } from "../../data/connection.ts";
import { listenerOwners, type ListenerAddress, type Owner } from "../../data/listener.ts";

type OriginLocality = typeof Locality.Type;

export type OwnerLookup = (address: ListenerAddress) => Promise<ReadonlyArray<Owner>>;

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

/** Unverifiable listeners (Windows, another user's process, nothing listening) stay Remote. */
export const originLocality = async (
  origin: Pick<ParsedOrigin, "hostname" | "port">,
  owners: OwnerLookup = listenerOwners
): Promise<OriginLocality> => {
  if (!localHost(origin.hostname)) return "remote";

  return ownersLocality(
    await owners({ hostname: origin.hostname, port: origin.port }).catch(() => [])
  );
};
