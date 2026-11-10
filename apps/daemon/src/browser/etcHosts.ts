/**
 * Names the Host's hosts file maps to loopback (ENG-621): Portless's `.test` names and custom
 * domains. They are Host addresses too, connected to the address the file gives them.
 */
import { type LoopbackAddress, loopbackAddressesOf } from "@polaris/protocol";

/** The hosts file on this platform. */
export const HOSTS_FILE =
  process.platform === "win32"
    ? `${process.env["SystemRoot"] ?? "C:\\Windows"}\\System32\\drivers\\etc\\hosts`
    : "/etc/hosts";

const HOST_NAME = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/;

/** The loopback address an entry's IP stands for, or null when it is not loopback. */
const loopbackOf = (ip: string): LoopbackAddress | null => {
  if (/^[0-9.]+$/.test(ip)) return loopbackAddressesOf(ip)?.[0] ?? null;

  // `::1` alone: an IPv4-mapped loopback entry is left out rather than guessed at.
  return ip.includes(":") && !/ffff/i.test(ip) ? (loopbackAddressesOf(ip)?.[0] ?? null) : null;
};

/**
 * Each name mapped to 127.0.0.0/8 or ::1, lowercased without a trailing dot, with the loopback
 * addresses it stands for in file order. Names already Host addresses (`localhost`) are left out.
 */
export const parseHostsFile = (
  text: string
): ReadonlyMap<string, ReadonlyArray<LoopbackAddress>> => {
  const names = new Map<string, Array<LoopbackAddress>>();

  for (const line of text.split(/\r?\n/)) {
    const [ip, ...aliases] = line.replace(/#.*/, "").trim().split(/\s+/);
    const address = ip === undefined ? null : loopbackOf(ip);

    if (address === null) continue;

    for (const alias of aliases) {
      const name = alias.toLowerCase().replace(/\.$/, "");

      if (!HOST_NAME.test(name) || /^[0-9.]+$/.test(name) || loopbackAddressesOf(name) !== null)
        continue;
      const known = names.get(name) ?? [];

      if (!known.includes(address)) known.push(address);
      names.set(name, known);
    }
  }

  return names;
};
