import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
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

/** Bytes hashed per read by `currentVersion`; one buffer, reused, so a version leaves no garbage. */
const HASH_CHUNK_BYTES = 64 * 1024;

const hashOpenFile = async (path: string, handle: FileHandle, chunk: Buffer) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await handle.stat();

    if (!before.isFile()) throw new FsFailure(path, "ENOTFILE", "not a regular file");

    if (before.size > EDITOR_FILE_MAX_BYTES)
      throw new FsFailure(path, "EFBIG", `EFBIG: ${before.size} bytes is too large to open`);
    const hash = createHash("sha256");
    let offset = 0;

    while (offset < before.size) {
      const want = Math.min(chunk.length, before.size - offset);
      const { bytesRead } = await handle.read(chunk, 0, want, offset);

      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }

    const after = await handle.stat();

    if (
      before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs &&
      before.size === after.size &&
      offset === after.size
    )
      return new FileVersion({ mtimeMs: after.mtimeMs, size: offset, hash: hash.digest("hex") });
  }

  throw new FsFailure(path, "EBUSY", "file changed while reading; retry");
};

/** The version `readVersioned` would report, hashed in chunks rather than read whole; null if missing. */
export const currentVersion = async (input: string): Promise<FileVersion | null> => {
  const path = resolveHostPath(input);

  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);

    try {
      return await hashOpenFile(path, handle, Buffer.allocUnsafe(HASH_CHUNK_BYTES));
    } finally {
      await handle.close();
    }
  } catch (cause) {
    const failure = toFsFailure(path, cause);

    if (failure.code === "ENOENT") return null;
    throw failure;
  }
};
