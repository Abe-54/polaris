/**
 * What a Visualization frame may ask of the app (ADR 0089): its height, a link to open after
 * the user confirms, and its `pv.state`. Anything else, or anything from another window, is dropped.
 */
import {
  boundedJson,
  FRAME_HEIGHT_MAX,
  FRAME_HEIGHT_MIN,
  FrameMessage,
} from "@polaris/visualization";
import { Match, Option, Schema } from "effect";
import { STATE_MAX_BYTES } from "./state.ts";

export type FrameRequest =
  | { readonly kind: "height"; readonly height: number }
  | { readonly kind: "open-link"; readonly url: string }
  /** The state envelope as JSON text, stored as it is. */
  | { readonly kind: "state"; readonly json: string };

const decode = Schema.decodeUnknownOption(FrameMessage);

export const clampHeight = (height: number) =>
  Math.min(FRAME_HEIGHT_MAX, Math.max(FRAME_HEIGHT_MIN, Math.ceil(height)));

/** The link as the browser will open it; null unless it is https. */
export const httpsLink = (url: string): string | null => {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);

  return parsed.protocol === "https:" ? parsed.href : null;
};

// Serialising stops at the cap, so a huge posted object costs about the cap, not its own size.
const stateJson = (message: Extract<FrameMessage, { readonly type: "pv:state" }>) =>
  boundedJson(message.state, STATE_MAX_BYTES);

const request = (message: FrameMessage): FrameRequest | null =>
  Match.value(message).pipe(
    Match.discriminatorsExhaustive("type")({
      "pv:height": ({ height }): FrameRequest | null =>
        Number.isFinite(height) ? { kind: "height", height: clampHeight(height) } : null,
      "pv:open-link": ({ url }): FrameRequest | null => {
        const link = httpsLink(url);

        return link === null ? null : { kind: "open-link", url: link };
      },
      "pv:state": (message): FrameRequest | null => {
        const json = stateJson(message);

        return json === null ? null : { kind: "state", json };
      },
    })
  );

/** True only for a message from `frame`, the frame's own window. */
export const fromFrame = (event: Pick<MessageEvent<unknown>, "source">, frame: Window | null) =>
  frame !== null && event.source === frame;

/** A message's request, once `fromFrame` has said where it came from. */
export const requestOf = (event: Pick<MessageEvent<unknown>, "data">): FrameRequest | null =>
  Option.getOrNull(Option.flatMapNullishOr(decode(event.data), request));

const decodeType = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.String }));

/** The message's `type`, read without decoding the rest. */
export const typeOf = (event: Pick<MessageEvent<unknown>, "data">): string | undefined =>
  Option.getOrUndefined(Option.map(decodeType(event.data), ({ type }) => type));

/** A message event's request, only when it came from `frame`, the frame's own window. */
export const frameRequest = (
  event: Pick<MessageEvent<unknown>, "source" | "data">,
  frame: Window | null
): FrameRequest | null => (fromFrame(event, frame) ? requestOf(event) : null);
