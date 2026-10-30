/**
 * Builds the SDK user message for a Turn (or a steer): the prompt text, images
 * inlined as base64 content blocks, and every other attachment referenced by
 * its staged path on the Host so Claude reads it with its own tools.
 */
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Attachment, TurnId } from "@polaris/protocol";
import { Effect, Schema } from "effect";
import { HarnessError, HarnessEvent, type TurnInput } from "../HarnessDriver.ts";
import { steerItem } from "../userMessage.ts";

/** What a steer sends besides its text. */
export type SteerInput = Pick<TurnInput, "attachments" | "shellCommand">;

/** A steer sent that Claude Code hasn't folded into its Turn yet. */
export interface SteerSent {
  readonly turnId: TurnId;
  readonly text: string;
  readonly attachments: ReadonlyArray<Attachment>;
}

/** Claude Code took the steer in: it shows in its Turn from here, with what it carried. */
export const landedSteer = (uuid: string, steer: SteerSent) =>
  HarnessEvent.ItemCompleted({
    turnId: steer.turnId,
    item: steerItem(`steer:${uuid}`, steer.text, steer.attachments),
  });

/** Image types the Messages API accepts inline. */
const InlineImageType = Schema.Literals(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const isInlineImageType = Schema.is(InlineImageType);

/** The API's per-image limit is 5 MB; larger images are passed by path instead. */
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: typeof InlineImageType.Type;
        data: string;
      };
    };

export const isInlineImage = (a: Attachment): boolean =>
  isInlineImageType(a.mimeType) && a.size <= MAX_INLINE_IMAGE_BYTES;

/** The attachments sent inline, with their image type. */
const inlineImages = (attachments: ReadonlyArray<Attachment>) =>
  attachments.flatMap((attachment) => {
    const mediaType = attachment.mimeType;

    return isInlineImageType(mediaType) && attachment.size <= MAX_INLINE_IMAGE_BYTES
      ? [{ attachment, mediaType }]
      : [];
  });

export const attachmentNote = (files: ReadonlyArray<Attachment>): string =>
  [
    "Attached files (staged on this machine; read them from these paths):",
    ...files.map((f) => `- ${f.name} (${f.mimeType}): ${f.hostPath}`),
  ].join("\n");

export const buildUserMessage = Effect.fn("claude.buildUserMessage")(function* (options: {
  readonly uuid: NonNullable<SDKUserMessage["uuid"]>;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<Attachment>;
  /** Read a staged file; injectable for tests. */
  readonly readFile?: ((path: string) => Promise<Uint8Array>) | undefined;
}) {
  const readFile = options.readFile ?? ((path: string) => Bun.file(path).bytes());
  const images = inlineImages(options.attachments);
  const others = options.attachments.filter((a) => !isInlineImage(a));

  const content: ContentBlock[] = [];

  for (const { attachment: image, mediaType } of images) {
    const bytes = yield* Effect.tryPromise({
      try: () => readFile(image.hostPath),
      catch: (cause) =>
        new HarnessError({
          harness: "claude",
          message: `Could not read the attachment ${image.name}`,
          cause,
        }),
    });

    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: Buffer.from(bytes).toString("base64"),
      },
    });
  }

  const text =
    others.length > 0 ? `${options.prompt}\n\n${attachmentNote(others)}` : options.prompt;

  // The API refuses an empty text block; an images-only message sends none.
  if (text !== "" || content.length === 0) content.push({ type: "text", text });

  const message: SDKUserMessage = {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    uuid: options.uuid,
    origin: { kind: "human" },
  };

  return message;
});
