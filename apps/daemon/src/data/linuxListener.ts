import { readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { ListenerAddress, Owner } from "./listener.ts";

const socketPath = (connection: ListenerAddress) =>
  connection.path ||
  (connection.hostname.startsWith("/")
    ? join(connection.hostname, `.s.PGSQL.${connection.port}`)
    : undefined);

/** Decode LISTEN socket inodes only; established connections must never establish locality. */
export const tcpInodes = (text: string, port: number) =>
  text.split("\n").flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    const address = fields[1]?.split(":");
    const host = address?.[0];

    const local =
      host === "00000000" ||
      host === "00000000000000000000000000000000" ||
      host === "00000000000000000000000001000000" ||
      /^([A-F0-9]{6})7F$/i.test(host ?? "");

    return fields[3] === "0A" && local && parseInt(address?.[1] ?? "", 16) === port && fields[9]
      ? [fields[9]]
      : [];
  });

export const linuxOwners = async (connection: ListenerAddress): Promise<Owner[]> => {
  const inodes = await socketInodes(connection);

  if (!inodes.size) return [];
  const owners: Owner[] = [];
  const remaining = new Set(inodes);

  for (const pid of (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry))) {
    const dir = `/proc/${pid}`;
    const owned = await processInodes(dir, inodes);

    for (const inode of owned) remaining.delete(inode);
    const owns = owned.size > 0;

    if (owns)
      owners.push({ pid: Number(pid), executable: await readlink(`${dir}/exe`).catch(() => "") });
  }

  return remaining.size ? [] : owners;
};

const socketInodes = async (connection: ListenerAddress) => {
  const socket = socketPath(connection);
  const inodes = new Set<string>();

  if (socket) {
    const text = await readFile("/proc/net/unix", "utf8");

    for (const line of text.split("\n")) {
      const fields = line.trim().split(/\s+/);

      if (fields[7] === socket && fields[6]) inodes.add(fields[6]);
    }
  } else {
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"])
      for (const inode of tcpInodes(await readFile(file, "utf8"), connection.port))
        inodes.add(inode);
  }

  return inodes;
};

const processInodes = async (dir: string, inodes: Set<string>) => {
  const owned = new Set<string>();
  const fds = await readdir(`${dir}/fd`).catch(() => []);

  for (const fd of fds) {
    const inode = /^socket:\[(\d+)\]$/.exec(await readlink(`${dir}/fd/${fd}`).catch(() => ""))?.[1];

    if (inode && inodes.has(inode)) owned.add(inode);
  }

  return owned;
};
