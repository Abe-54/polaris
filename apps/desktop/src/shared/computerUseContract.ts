/**
 * Computer use over IPC (ENG-846): each forwards the Daemon RPC of the same name on that Host,
 * only when its Daemon announces `computer-use`; answers cross unchanged.
 */
import {
  OpenComputerUseSetup,
  RemoveAllowedApp,
  SessionId,
  type AllowedApp,
  type AppWindow,
  type ComputerUseItem,
  type ComputerUseStatus,
  type PreviewIdleReason,
} from "@polaris/protocol";
import { Data, Schema } from "effect";

const OnHost = { hostKey: Schema.String.check(Schema.isMinLength(1)) };

/** A session's preview: the longer side wanted in pixels, null for the largest. */
const Preview = Schema.Struct({
  ...OnHost,
  sessionId: SessionId,
  maxEdgePx: Schema.NullOr(Schema.Int),
});

/** One preview image with its bytes (a JPEG), taken from its blob in the main process. */
export interface PreviewImage {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly capturedAt: string;
  readonly window: AppWindow | null;
}

/**
 * The live preview feed: frames, an idle reason, or `NoLive` once, at the start, on a Host
 * without live capture (Linux, Windows, an older Daemon); `computerUse.preview.latest` then.
 */
export type PreviewFeedItem = Data.TaggedEnum<{
  Frame: { readonly image: PreviewImage };
  Idle: { readonly reason: PreviewIdleReason };
  NoLive: Record<never, never>;
}>;

/** Its constructors; across IPC an item arrives as a plain object with the same `_tag`. */
export const PreviewFeedItem = Data.taggedEnum<PreviewFeedItem>();

export const ComputerUseRequestInputs = {
  "computerUse.status": Schema.Struct({ ...OnHost, refresh: Schema.Boolean }),
  "computerUse.enable": Schema.Struct(OnHost),
  "computerUse.disable": Schema.Struct(OnHost),
  "computerUse.openSetup": Schema.Struct({
    ...OnHost,
    ...OpenComputerUseSetup.payloadSchema.fields,
  }),
  "computerUse.removeAllowedApp": Schema.Struct({
    ...OnHost,
    ...RemoveAllowedApp.payloadSchema.fields,
  }),
  "computerUse.preview.latest": Preview,
} as const;

export interface ComputerUseRequestOutputs {
  readonly "computerUse.status": ComputerUseStatus;
  readonly "computerUse.enable": ComputerUseStatus;
  readonly "computerUse.disable": ComputerUseStatus;
  readonly "computerUse.openSetup": ComputerUseStatus;
  readonly "computerUse.removeAllowedApp": ReadonlyArray<AllowedApp>;
  /** Null before the session's first action, or on a Host that can't take screenshots. */
  readonly "computerUse.preview.latest": PreviewImage | null;
}

export const ComputerUseSubscriptionInputs = {
  /** The Host feed: a status, the always-allowed and the controlled apps, then each on change. */
  "computerUse.watch": Schema.Struct(OnHost),
  /** Subscribing starts the Host's capture and unsubscribing stops it (D4). */
  "computerUse.preview.watch": Preview,
} as const;

export interface ComputerUseSubscriptionItems {
  readonly "computerUse.watch": ComputerUseItem;
  readonly "computerUse.preview.watch": PreviewFeedItem;
}
