import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeTempDir, tempDir } from "../git/testing.ts";
import { currentVersion, readVersioned } from "./version.ts";

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeTempDir(dir);
});

const dir = () => {
  const path = tempDir();
  cleanup.push(path);

  return path;
};

const KiB = 1024;

describe("currentVersion", () => {
  test.each([0, 1, 64 * KiB - 1, 64 * KiB, 3 * 64 * KiB + 17, 1024 * KiB + 5])(
    "a %i-byte file hashes to what readVersioned reports",
    async (size) => {
      const path = join(dir(), "file.bin");
      const bytes = Buffer.alloc(size);

      for (let index = 0; index < size; index++) bytes[index] = (index * 31 + 7) % 251;

      writeFileSync(path, bytes);

      const version = await currentVersion(path);

      expect(version?.size).toBe(size);
      expect(version?.hash).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(version).toEqual((await readVersioned(path)).version);
    }
  );

  test("a missing file is null and a directory is not a file", async () => {
    const root = dir();

    expect(await currentVersion(join(root, "missing"))).toBeNull();
    await Promise.resolve(expect(currentVersion(root)).rejects.toMatchObject({ code: "ENOTFILE" }));
  });
});
