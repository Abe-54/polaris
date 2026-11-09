/**
 * Small text attachments (a Browser pick's note, a pasted snippet) go into the prompt
 * itself, so the model sees them without reading the file first. Larger ones stay paths.
 */
import type { Attachment, AttachmentId } from "@polaris/protocol";
import { Effect } from "effect";

/** The most text a single attachment puts into the prompt. */
export const MAX_INLINE_TEXT_BYTES = 8 * 1024;

const INLINE_TEXT_TYPES = new Set(["text/markdown", "text/plain"]);

const baseType = (mimeType: string) => mimeType.split(";")[0]?.trim().toLowerCase() ?? "";

/** Whether an attachment is small Markdown or plain text, worth reading into the prompt. */
export const isInlineTextCandidate = (a: Attachment): boolean =>
  INLINE_TEXT_TYPES.has(baseType(a.mimeType)) && a.size <= MAX_INLINE_TEXT_BYTES;

const utf8 = new TextDecoder("utf-8", { fatal: true });

const decode = (bytes: Uint8Array): string | null => {
  if (bytes.byteLength > MAX_INLINE_TEXT_BYTES) return null;

  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
};

/** Text of each inlinable attachment; one that can't be read, isn't UTF-8 or grew stays a path. */
export const readInlineTexts = Effect.fn("harness.readInlineTexts")(function* (
  attachments: ReadonlyArray<Attachment>,
  readFile: (path: string) => Promise<Uint8Array> = (path) => Bun.file(path).bytes()
) {
  const texts = new Map<AttachmentId, string>();

  for (const attachment of attachments.filter(isInlineTextCandidate)) {
    const bytes = yield* Effect.tryPromise(() => readFile(attachment.hostPath)).pipe(
      Effect.orElseSucceed(() => null)
    );

    const text = bytes === null ? null : decode(bytes);

    if (text !== null) texts.set(attachment.id, text);
  }

  const read: ReadonlyMap<AttachmentId, string> = texts;

  return read;
});

/** An inlined attachment as the prompt carries it: its name, path and text. */
export const inlineTextBlock = (attachment: Attachment, text: string): string =>
  [
    `<attached-file name="${attachment.name}" type="${baseType(attachment.mimeType)}" path="${attachment.hostPath}">`,
    text.endsWith("\n") ? text.slice(0, -1) : text,
    "</attached-file>",
  ].join("\n");
