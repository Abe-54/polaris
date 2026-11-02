import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PinnedFile } from "./catalog.ts";
import { downloadFile, freeBytes, isDownloaded, ManagedSetupError, partPath } from "./download.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

const BYTES = Buffer.from("a verified model file, two hundred bytes long".repeat(5));

const pinned = (sha256 = createHash("sha256").update(BYTES).digest("hex")): PinnedFile => ({
  name: "model.gguf",
  url: "https://publisher.example/model.gguf",
  sizeBytes: BYTES.length,
  sha256,
});

/** A publisher that honours Range and counts requests; `fail` cuts the body after n bytes. */
const publisher = (options: { readonly cutAt?: number } = {}) => {
  const requests: Array<string | null> = [];

  const fetch = async (_url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    const range = headers.get("range");
    requests.push(range);
    const from = range === null ? 0 : Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
    const to = options.cutAt === undefined ? BYTES.length : Math.min(BYTES.length, options.cutAt);
    const body = BYTES.subarray(from, Math.max(from, to));

    return new Response(new Uint8Array(body), { status: from === 0 ? 200 : 206 });
  };

  return { fetch, requests };
};

const PLENTY = async () => 100 * 1024 ** 3;

/** The ManagedSetupError a download rejects with; anything else fails the test. */
const rejection = async (run: Promise<unknown>): Promise<ManagedSetupError> => {
  try {
    await run;
  } catch (error) {
    if (error instanceof ManagedSetupError) return error;
  }

  throw new Error("expected a ManagedSetupError");
};

const scratch = () => newTempDir("pl-managed-dl-");

const run = (dir: string, file: PinnedFile, fetch: ReturnType<typeof publisher>["fetch"]) => {
  const progress: number[] = [];

  return downloadFile({
    file,
    dir,
    fetch,
    signal: new AbortController().signal,
    onProgress: (n) => progress.push(n),
    free: PLENTY,
  }).then(() => progress);
};

test("a complete download is verified and renamed into place", async () => {
  const dir = scratch();

  try {
    const { fetch } = publisher();
    const progress = await run(dir, pinned(), fetch);
    expect(readFileSync(join(dir, "model.gguf"))).toEqual(BYTES);
    expect(progress.at(-1)).toBe(BYTES.length);
    expect(await isDownloaded(dir, pinned())).toBe(true);
  } finally {
    removeTempDir(dir);
  }
});

test("a partial download resumes with Range from the part file's length", async () => {
  const dir = scratch();

  try {
    const cut = publisher({ cutAt: 100 });
    expect((await rejection(run(dir, pinned(), cut.fetch))).reason).toBe("download-failed");
    expect(readFileSync(partPath(dir, pinned())).length).toBe(100);

    const whole = publisher();
    await run(dir, pinned(), whole.fetch);
    expect(whole.requests).toEqual(["bytes=100-"]);
    expect(readFileSync(join(dir, "model.gguf"))).toEqual(BYTES);
  } finally {
    removeTempDir(dir);
  }
});

test("a checksum mismatch refuses the file and discards the part", async () => {
  const dir = scratch();

  try {
    const { fetch } = publisher();
    const error = await rejection(run(dir, pinned("0".repeat(64)), fetch));
    expect(error.reason).toBe("checksum-mismatch");
    expect(() => readFileSync(join(dir, "model.gguf"))).toThrow();
    expect(() => readFileSync(partPath(dir, pinned()))).toThrow();
  } finally {
    removeTempDir(dir);
  }
});

test("a file already in the folder with the right hash counts as downloaded without a request", async () => {
  const dir = scratch();

  try {
    writeFileSync(join(dir, "model.gguf"), BYTES);
    const { fetch, requests } = publisher();
    await run(dir, pinned(), fetch);
    expect(requests).toEqual([]);
    writeFileSync(join(dir, "model.gguf"), BYTES.subarray(1));
    expect(await isDownloaded(dir, pinned())).toBe(false);
  } finally {
    removeTempDir(dir);
  }
});

test("too little free space refuses before any byte is fetched", async () => {
  const dir = scratch();

  try {
    const { fetch, requests } = publisher();

    const error = await rejection(
      downloadFile({
        file: pinned(),
        dir,
        fetch,
        signal: new AbortController().signal,
        onProgress: () => {},
        free: async () => 100,
      })
    );

    expect(error.reason).toBe("no-space");
    expect(requests).toEqual([]);
  } finally {
    removeTempDir(dir);
  }
});

test("cancelling stops the download and keeps the part for a resume", async () => {
  const dir = scratch();

  try {
    const controller = new AbortController();

    const fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new Uint8Array(BYTES.subarray(0, 50)));
          },
        })
      );

    const error = await rejection(
      downloadFile({
        file: pinned(),
        dir,
        fetch,
        signal: controller.signal,
        // The user cancels once the first bytes have landed.
        onProgress: (received) => {
          if (received > 0) controller.abort();
        },
        free: PLENTY,
      })
    );

    expect(error.message).toBe("Download cancelled");
    expect(readFileSync(partPath(dir, pinned())).length).toBe(50);
  } finally {
    removeTempDir(dir);
  }
});

/** How far free space may move between two reads while other processes write. */
const DISK_CHURN_BYTES = 256 * 1024 * 1024;

test("free space is read from the nearest existing ancestor of a folder not yet made", async () => {
  const dir = newTempDir("polaris-free-");
  const missing = join(dir, "models", "deeper");

  // Other processes (parallel test workers) write to the disk between two reads.
  const near = async (path: string, ancestor: string) => {
    const [read, expected] = [await freeBytes(path), await freeBytes(ancestor)];

    expect(read).toBeGreaterThan(0);
    expect(Math.abs((read ?? 0) - (expected ?? 0))).toBeLessThan(DISK_CHURN_BYTES);
  };

  await near(missing, dir);
  await near("/nonexistent-root-xyz/sub", "/");
});
