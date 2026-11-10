/**
 * app.json for one build: the network whitelist lists every origin the app
 * may reach. A bare host gets both `https://` and `wss://`; wildcards, paths,
 * queries and fragments are refused.
 */

export interface Manifest {
  readonly version: string;
  readonly permissions: ReadonlyArray<{
    readonly name: string;
    readonly whitelist?: ReadonlyArray<string>;
  }>;
}

const SCHEMES = new Set(["https:", "wss:", "http:", "ws:"]);

const DNS_OR_IPV4 = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

const IPV6 = /^\[[0-9a-f:.]+\]$/;

/** One exact Host: no wildcard or other non-DNS character, no path, query or fragment. */
const isExactOrigin = (url: URL): boolean =>
  (DNS_OR_IPV4.test(url.hostname) || IPV6.test(url.hostname)) &&
  url.pathname === "/" &&
  url.search === "" &&
  url.hash === "";

export class BadHost extends Error {}

/** `mac.tailnet.ts.net`, `wss://mac.tailnet.ts.net` or `ws://127.0.0.1:7477` → origins. */
export const originsOf = (host: string): ReadonlyArray<string> => {
  const withScheme = host.includes("://") ? host : `https://${host}`;
  let url: URL;

  try {
    url = new URL(withScheme);
  } catch {
    throw new BadHost(`not a host or origin: ${host}`);
  }

  const plain = SCHEMES.has(url.protocol) && url.username === "" && url.password === "";

  if (!plain || !isExactOrigin(url)) throw new BadHost(`not a host or origin: ${host}`);

  return host.includes("://") ? [url.origin] : [url.origin, `wss://${url.host}`];
};

export const withWhitelist = <M extends Manifest>(
  manifest: M,
  hosts: ReadonlyArray<string>,
  version: string
): Omit<M, keyof Manifest> & Manifest => {
  const whitelist = [...new Set(hosts.flatMap(originsOf))];

  return {
    ...manifest,
    version,
    permissions: manifest.permissions.map((permission) =>
      permission.name === "network" ? { ...permission, whitelist } : permission
    ),
  };
};

export const hostsFromArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args.flatMap((arg, index) => {
    if (arg.startsWith("--host=")) return [arg.slice("--host=".length)];

    return arg === "--host" && args[index + 1] !== undefined ? [args[index + 1] ?? ""] : [];
  });
