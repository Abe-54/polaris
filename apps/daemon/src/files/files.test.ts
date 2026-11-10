import { afterEach, describe, expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileError, ReadFile } from "@polaris/protocol";
import { Effect, Fiber, Stream } from "effect";
import { removeTempDir, tempDir, write } from "../git/testing.ts";
import { clearFileReads, fileReadBursts } from "../memory/fileReads.ts";
import { handleListDir, handleReadFile, handleStat } from "./FilesRpcs.ts";
import { INLINE_TEXT_MAX_BYTES, STREAM_MIN_BYTES } from "./fs.ts";
import { detectMimeType } from "./mime.ts";
import { makeFakeBlobChannel } from "./testing.ts";

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeTempDir(dir);
});

const dir = () => {
  const path = tempDir();
  cleanup.push(path);

  return path;
};

const read = (path: string, offset: number | null = null, length: number | null = null) => {
  const blobs = makeFakeBlobChannel();

  return Effect.runPromise(
    handleReadFile({ path, offset, length }).pipe(Effect.provide(blobs.layer))
  ).then((result) => ({ result, blobs }));
};

const Content = ReadFile.successSchema.fields.content;

const blobIdOf = (content: typeof Content.Type) => {
  if (!Content.guards.Blob(content)) throw new Error("expected a blob");

  return content.blobId;
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe("files.read", () => {
  test("small text comes back inline with its mime type", async () => {
    const root = dir();
    write(root, "a.ts", "export const x = 1\n");
    const { result } = await read(join(root, "a.ts"));
    expect(result.size).toBe(19);
    expect(result.mimeType).toBe("text/typescript");
    expect(result.content).toEqual(Content.cases.Inline.make({ text: "export const x = 1\n" }));
  });

  test("ranged reads return just the range but the whole file's size", async () => {
    const root = dir();
    write(root, "n.txt", "0123456789");
    const { result } = await read(join(root, "n.txt"), 3, 4);
    expect(result.size).toBe(10);
    expect(result.content).toEqual(Content.cases.Inline.make({ text: "3456" }));
    const past = await read(join(root, "n.txt"), 8, 100);
    expect(past.result.content).toEqual(Content.cases.Inline.make({ text: "89" }));
  });

  test("text over the inline threshold goes through the BlobChannel", async () => {
    const root = dir();
    const big = "x".repeat(INLINE_TEXT_MAX_BYTES + 1);
    write(root, "big.txt", big);
    const { result, blobs } = await read(join(root, "big.txt"));
    expect(result.content._tag).toBe("Blob");
    expect(blobs.blobs.get(blobIdOf(result.content))!.byteLength).toBe(big.length);
  });

  test("very large ranges are streamed into the BlobChannel", async () => {
    const root = dir();
    const bytes = new Uint8Array(STREAM_MIN_BYTES + 10).map((_, i) => i % 251);
    writeFileSync(join(root, "huge.bin"), bytes);
    const { result, blobs } = await read(join(root, "huge.bin"), 5, STREAM_MIN_BYTES + 2);
    const got = blobs.blobs.get(blobIdOf(result.content))!;
    expect(got.byteLength).toBe(STREAM_MIN_BYTES + 2);
    expect(got[0]).toBe(5);
  });

  test.each([
    ["sent whole", STREAM_MIN_BYTES],
    ["streamed", STREAM_MIN_BYTES + 1],
  ])("a large read %s counts toward the quiet release", async (_, size) => {
    const root = dir();
    writeFileSync(join(root, "big.bin"), new Uint8Array(size).fill(7));
    clearFileReads();

    const burst = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkScoped(Stream.runHead(fileReadBursts));

          for (let tick = 0; tick < 5; tick++) yield* Effect.yieldNow;
          yield* Effect.promise(() => read(join(root, "big.bin")));

          return yield* Fiber.join(fiber).pipe(Effect.timeoutOption("1 second"));
        })
      )
    );

    expect(burst._tag).toBe("Some");
  });

  test("images and PDFs are detected by magic bytes and sent as blobs", async () => {
    const root = dir();
    writeFileSync(join(root, "shot.dat"), PNG);
    writeFileSync(join(root, "doc"), new TextEncoder().encode("%PDF-1.7\n..."));
    const png = await read(join(root, "shot.dat"));
    expect(png.result.mimeType).toBe("image/png");
    expect(png.result.content._tag).toBe("Blob");
    const pdf = await read(join(root, "doc"));
    expect(pdf.result.mimeType).toBe("application/pdf");
    expect(pdf.result.content._tag).toBe("Blob");
  });

  test("a range that cuts a UTF-8 character is sent as bytes", async () => {
    const root = dir();
    write(root, "u.txt", "héllo");
    const { result } = await read(join(root, "u.txt"), 0, 2);
    expect(result.mimeType).toBe("text/plain");
    expect(result.content._tag).toBe("Blob");
  });

  test("missing files and directories fail with FileError codes", async () => {
    const root = dir();

    const missing = await Effect.runPromise(
      Effect.flip(handleReadFile({ path: join(root, "nope"), offset: null, length: null })).pipe(
        Effect.provide(makeFakeBlobChannel().layer)
      )
    );

    expect(missing).toBeInstanceOf(FileError);
    expect(missing.code).toBe("ENOENT");

    const isDir = await Effect.runPromise(
      Effect.flip(handleReadFile({ path: root, offset: null, length: null })).pipe(
        Effect.provide(makeFakeBlobChannel().layer)
      )
    );

    expect(isDir).toBeInstanceOf(FileError);
    expect(isDir.code).toBe("EISDIR");
  });
});

describe("files.listDir and files.stat", () => {
  test("lists directories first with kinds, sizes and absolute paths", async () => {
    const root = dir();
    write(root, "b.txt", "bb");
    write(root, "a/inner.txt", "x");
    symlinkSync(join(root, "b.txt"), join(root, "link"));
    const entries = await Effect.runPromise(handleListDir({ path: root }));
    expect(entries.map((e) => [e.name, e.kind])).toEqual([
      ["a", "directory"],
      ["b.txt", "file"],
      ["link", "symlink"],
    ]);
    expect(entries[1]!.path).toBe(join(root, "b.txt"));
    expect(entries[1]!.size).toBe(2);
    const stat = await Effect.runPromise(handleStat({ path: join(root, "b.txt") }));
    expect(stat).toMatchObject({ name: "b.txt", kind: "file", size: 2 });
    expect(Number.isNaN(Date.parse(stat.modifiedAt))).toBe(false);
  });

  test("a missing directory is ENOENT", async () => {
    const error = await Effect.runPromise(
      Effect.flip(handleListDir({ path: "/definitely/not/here" }))
    );

    expect(error).toBeInstanceOf(FileError);
    expect(error.code).toBe("ENOENT");
  });
});

describe("mime detection", () => {
  test("magic bytes beat the extension; unknown text is text/plain", () => {
    expect(detectMimeType("x.txt", PNG)).toBe("image/png");
    expect(detectMimeType("x.json", new TextEncoder().encode("{}"))).toBe("application/json");
    expect(detectMimeType("Makefile", new TextEncoder().encode("all:\n"))).toBe("text/plain");
    expect(detectMimeType("blob", new Uint8Array([1, 0, 2]))).toBe("application/octet-stream");
  });
});
