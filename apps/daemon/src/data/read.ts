import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

/** The default cap on a file read from checkout content. */
export const READ_LIMIT = 64 * 1024;

const inside = (root: string, file: string) => {
  const path = relative(root, file);

  return (
    path !== ".." &&
    !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(path)
  );
};

/** No following file symlinks, device reads, or unbounded allocations from checkout content. */
export const read = async (checkout: string, file: string, limit = READ_LIMIT): Promise<string> => {
  try {
    const root = await realpath(checkout);
    const path = join(root, file);
    const before = await lstat(path);

    if (!before.isFile() || before.size > limit) return "";
    const canonical = await realpath(path);

    if (!inside(root, canonical)) return "";

    const handle = await open(
      canonical,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );

    try {
      const opened = await handle.stat();

      if (
        !opened.isFile() ||
        opened.size > limit ||
        opened.ino !== before.ino ||
        opened.dev !== before.dev
      )
        return "";

      if (!inside(root, await realpath(path))) return "";
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;

      while (length <= limit) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);

        if (bytesRead === 0) break;
        length += bytesRead;
      }

      return length > limit ? "" : buffer.subarray(0, length).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
};
