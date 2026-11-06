import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { EDITOR_FILE_MAX_BYTES, FileVersion } from "@polaris/protocol";
import { noteFileRead } from "../memory/fileReads.ts";
import { FsFailure, resolveHostPath, toFsFailure } from "./fs.ts";

export const sameVersion = (a: FileVersion | null, b: FileVersion | null): boolean =>
  a === null || b === null
    ? a === b
    : a.mtimeMs === b.mtimeMs && a.size === b.size && a.hash === b.hash;

export const readVersioned = async (input: string) => {
  const path = resolveHostPath(input);

  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);

    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await handle.stat();

        if (!before.isFile()) throw new FsFailure(path, "ENOTFILE", "not a regular file");

        if (before.size > EDITOR_FILE_MAX_BYTES)
          throw new FsFailure(path, "EFBIG", `EFBIG: ${before.size} bytes is too large to open`);
        const bytes = Buffer.alloc(before.size);
        let offset = 0;

        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);

          if (bytesRead === 0) break;
          offset += bytesRead;
        }

        const after = await handle.stat();

        if (
          before.mtimeMs === after.mtimeMs &&
          before.ctimeMs === after.ctimeMs &&
          before.size === after.size &&
          offset === after.size
        ) {
          noteFileRead(bytes.length);

          return {
            bytes,
            mode: after.mode,
            ino: after.ino,
            dev: after.dev,
            version: new FileVersion({
              mtimeMs: after.mtimeMs,
              size: bytes.length,
              hash: createHash("sha256").update(bytes).digest("hex"),
            }),
          };
        }
      }

      throw new FsFailure(path, "EBUSY", "file changed while reading; retry");
    } finally {
      await handle.close();
    }
  } catch (cause) {
    throw toFsFailure(path, cause);
  }
};

export const currentVersion = async (path: string): Promise<FileVersion | null> => {
  try {
    return (await readVersioned(path)).version;
  } catch (cause) {
    const failure = toFsFailure(path, cause);

    if (failure.code === "ENOENT") return null;
    throw failure;
  }
};
