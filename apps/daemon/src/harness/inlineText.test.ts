import { describe, expect, test } from "bun:test";
import { Attachment, AttachmentId } from "@polaris/protocol";
import { Effect } from "effect";
import { MAX_INLINE_TEXT_BYTES, readInlineTexts } from "./inlineText.ts";

const file = (name: string, mimeType: string, size: number) =>
  new Attachment({
    id: AttachmentId.make(name),
    name,
    mimeType,
    size,
    hostPath: `/stage/${name}`,
    width: null,
    height: null,
  });

const read = (attachments: ReadonlyArray<Attachment>, files: Record<string, Uint8Array>) =>
  Effect.runPromise(
    readInlineTexts(attachments, async (path) => {
      const bytes = files[path];

      if (bytes === undefined) throw new Error(`ENOENT ${path}`);

      return bytes;
    })
  );

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("inline text attachments", () => {
  test("small Markdown and plain text are read; other types and larger files are not", async () => {
    const atLimit = "x".repeat(MAX_INLINE_TEXT_BYTES);

    const texts = await read(
      [
        file("pick.md", "text/markdown", 5),
        file("log.txt", "text/plain; charset=utf-8", atLimit.length),
        file("big.md", "text/markdown", MAX_INLINE_TEXT_BYTES + 1),
        file("data.json", "application/json", 2),
      ],
      {
        "/stage/pick.md": utf8("# hi\n"),
        "/stage/log.txt": utf8(atLimit),
        "/stage/big.md": utf8("y".repeat(MAX_INLINE_TEXT_BYTES + 1)),
        "/stage/data.json": utf8("{}"),
      }
    );

    expect([...texts]).toEqual([
      [AttachmentId.make("pick.md"), "# hi\n"],
      [AttachmentId.make("log.txt"), atLimit],
    ]);
  });

  test("a file that can't be read, isn't UTF-8 or grew past the limit stays a path", async () => {
    const texts = await read(
      [
        file("gone.md", "text/markdown", 3),
        file("latin1.txt", "text/plain", 1),
        file("grew.md", "text/markdown", 1),
      ],
      {
        "/stage/latin1.txt": new Uint8Array([0xff]),
        "/stage/grew.md": utf8("z".repeat(MAX_INLINE_TEXT_BYTES + 1)),
      }
    );

    expect(texts.size).toBe(0);
  });
});
