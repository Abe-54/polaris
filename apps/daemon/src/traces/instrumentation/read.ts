import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export const contains = (root: string, path: string) => {
  const rel = relative(root, path);

  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Checkout discovery never follows file symlinks or reads more than 64 KiB per regular file. */
export const readCheckoutFile = async (checkout: string, file: string): Promise<string> => {
  try {
    const root = await realpath(checkout);
    const path = join(root, file);
    const before = await lstat(path);

    if (!contains(root, path) || !before.isFile() || before.size > 65536) return "";
    const canonical = await realpath(path);

    if (!contains(root, canonical)) return "";

    const handle = await open(
      canonical,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );

    try {
      const stat = await handle.stat();

      if (!stat.isFile() || stat.size > 65536 || stat.ino !== before.ino || stat.dev !== before.dev)
        return "";

      if (!contains(root, await realpath(path))) return "";
      const buffer = Buffer.alloc(65537);
      let length = 0;

      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);

        if (bytesRead === 0) break;
        length += bytesRead;
      }

      return length > 65536 ? "" : buffer.subarray(0, length).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
};
