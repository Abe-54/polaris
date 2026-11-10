/**
 * Computer use (CONTEXT.md; ENG-846, ADR 0104): an Agent Session operating its Host's desktop
 * apps. This file is the wire contract: each Host's status and its feed, the app an approval
 * names, the always-allowed list, the preview, and a Tool Call's app and window.
 * `computer-use.md` beside the package README is the write-up. Capability `computer-use`.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { NotFound, Unsupported } from "./errors.ts";
import { BlobId, SessionId, Timestamp } from "./ids.ts";

// ── Apps ────────────────────────────────────────────────────────────────────

/**
 * An app's stable id on its Host: the bundle id on macOS (`com.figma.Desktop`), the
 * executable's path on Windows, the `.desktop` id on Linux. Never its display name.
 */
export const AppId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)).pipe(
  Schema.brand("AppId")
);

export type AppId = typeof AppId.Type;

/** An app icon is at most this many pixels on each side. */
export const APP_ICON_MAX_EDGE_PX = 64;

/** An app icon's PNG is at most this many bytes. */
export const APP_ICON_MAX_BYTES = 32 * 1024;

const PNG_SIGNATURE_BASE64 = "iVBORw0KGgo";

const base64Bytes = (text: string) =>
  Math.floor((text.length * 3) / 4) - (text.length - text.replace(/=+$/, "").length);

/**
 * A small PNG as standard base64, so it fits in an event and a JSON frame: at most
 * `APP_ICON_MAX_EDGE_PX` on each side (the Daemon scales it) and `APP_ICON_MAX_BYTES`.
 */
export const AppIcon = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
  Schema.makeFilter((text: string) => text.startsWith(PNG_SIGNATURE_BASE64) || "Expected a PNG"),
  Schema.makeFilter(
    (text: string) => base64Bytes(text) <= APP_ICON_MAX_BYTES || "The icon is too large"
  )
);

export type AppIcon = typeof AppIcon.Type;

const AppName = Schema.String.check(Schema.isMaxLength(256));

/** A desktop app as an approval and the always-allowed list show it. */
export class DesktopApp extends Schema.Class<DesktopApp>("DesktopApp")({
  id: AppId,
  /** Its display name on the Host ("Figma"); the id when the Host gives none. */
  name: AppName,
  /** Null when the Host has no icon for it. */
  icon: Schema.NullOr(AppIcon),
}) {}

/** An app by id and name, without its icon: `computerUse.app` answers the icon. */
export class AppRef extends Schema.Class<AppRef>("AppRef")({ id: AppId, name: AppName }) {}

/** One of an app's windows, by the Host's own window id (a CGWindowID on macOS), as text. */
export class AppWindow extends Schema.Class<AppWindow>("AppWindow")({
  id: Schema.String,
  /** Null when the window has no title. */
  title: Schema.NullOr(Schema.String),
}) {}

/**
 * What links a computer use Tool Call to its app and window (`TurnItem.ToolCall.computerUse`).
 * `app` is null for a call about no one app (listing apps); `window` when it names no window.
 */
export class ComputerUseCall extends Schema.Class<ComputerUseCall>("ComputerUseCall")({
  app: Schema.NullOr(AppRef),
  window: Schema.NullOr(AppWindow),
  /** Headed input: the real pointer and keyboard, as for apps with no accessibility tree. */
  headed: Schema.Boolean,
}) {}

// ── Status ──────────────────────────────────────────────────────────────────

/** What is missing before computer use can run on this Host. */
export const ComputerUseSetup = Schema.TaggedUnion({
  /** macOS: each permission of Polaris Computer Use.app, true once granted; one is false. */
  MacPermissions: { accessibility: Schema.Boolean, screenRecording: Schema.Boolean },
  /** Linux: packages to install; `command` installs them with this Host's package manager. */
  LinuxPackages: { packages: Schema.Array(Schema.String), command: Schema.NullOr(Schema.String) },
  /** Linux: the accessibility bus (AT-SPI) is off or not running. */
  AccessibilityBus: {},
});

export type ComputerUseSetup = typeof ComputerUseSetup.Type;

/**
 * The first that applies, in this order. `NoDesktop`: the Host has no desktop session, which
 * the Daemon detects itself. `Off`: the user has not turned computer use on for this Host.
 * `NeedsSetup`: it is on and something is missing. `Ready`: sessions get the tools.
 */
export const ComputerUseState = Schema.TaggedUnion({
  NoDesktop: {},
  Off: {},
  NeedsSetup: { setup: ComputerUseSetup },
  Ready: {},
});

export type ComputerUseState = typeof ComputerUseState.Type;

export class ComputerUseStatus extends Schema.Class<ComputerUseStatus>("ComputerUseStatus")({
  state: ComputerUseState,
  /** When the Daemon last checked the Host. */
  checkedAt: Timestamp,
}) {}

/** An app the user always allows on this Host. */
export class AllowedApp extends Schema.Class<AllowedApp>("AllowedApp")({
  app: DesktopApp,
  allowedAt: Timestamp,
}) {}

/** An app an Agent Session controls now: no other session may use it until that Turn ends. */
export class ControlledApp extends Schema.Class<ControlledApp>("ControlledApp")({
  app: AppRef,
  sessionId: SessionId,
  since: Timestamp,
}) {}

/**
 * The Host feed. One of each first, then each again, whole, whenever it changes. A new item
 * kind needs its own capability, sent only to Clients that announce it.
 */
export const ComputerUseItem = Schema.TaggedUnion({
  Status: { status: ComputerUseStatus },
  AllowedApps: { apps: Schema.Array(AllowedApp) },
  ControlledApps: { apps: Schema.Array(ControlledApp) },
});

export type ComputerUseItem = typeof ComputerUseItem.Type;

/** Opening setup failed on the Host; the message is Polaris's own. */
export class ComputerUseSetupFailed extends Schema.TaggedError<ComputerUseSetupFailed>()(
  "ComputerUseSetupFailed",
  { message: Schema.String }
) {}

export const GetComputerUse = Rpc.make("computerUse.status", {
  /** `refresh` checks the Host again instead of answering from the Daemon's last check. */
  payload: { refresh: Schema.Boolean },
  success: ComputerUseStatus,
  error: Unsupported,
});

/** The Host feed of `ComputerUseItem`s; ending the stream unsubscribes. */
export const WatchComputerUse = Rpc.make("computerUse.watch", {
  payload: {},
  success: ComputerUseItem,
  error: Unsupported,
  stream: true,
});

/** Turns computer use on for this Host and answers the new status; on again is fine. */
export const EnableComputerUse = Rpc.make("computerUse.enable", {
  payload: {},
  success: ComputerUseStatus,
  error: Unsupported,
});

/** Turns it off: sessions lose the tools and every Controlled app is released; off again is fine. */
export const DisableComputerUse = Rpc.make("computerUse.disable", {
  payload: {},
  success: ComputerUseStatus,
  error: Unsupported,
});

export const ComputerUsePermission = Schema.Literals(["accessibility", "screen-recording"]);

export type ComputerUsePermission = typeof ComputerUsePermission.Type;

/**
 * Opens setup on the Host itself (its System Settings pane, with the macOS prompt), never
 * on the Client's machine. `permission` null opens the Host's one step for everything missing.
 */
export const OpenComputerUseSetup = Rpc.make("computerUse.openSetup", {
  payload: { permission: Schema.NullOr(ComputerUsePermission) },
  success: ComputerUseStatus,
  error: Schema.Union([Unsupported, ComputerUseSetupFailed]),
});

/** The Host's always-allowed apps, by name. */
export const ListAllowedApps = Rpc.make("computerUse.allowedApps", {
  payload: {},
  success: Schema.Array(AllowedApp),
  error: Unsupported,
});

/**
 * Removes an app from the always-allowed list and answers the list; an app not on it is fine.
 * Sessions that relied on it ask again before their next action in that app.
 */
export const RemoveAllowedApp = Rpc.make("computerUse.removeAllowedApp", {
  payload: { appId: AppId },
  success: Schema.Array(AllowedApp),
  error: Unsupported,
});

/** An app with its icon, for a Tool Call's `AppRef`; `NotFound` when the Host has no such app. */
export const GetDesktopApp = Rpc.make("computerUse.app", {
  payload: { appId: AppId },
  success: DesktopApp,
  error: Schema.Union([NotFound, Unsupported]),
});

// ── Preview ─────────────────────────────────────────────────────────────────

/** Every preview image is a JPEG. */
export const PREVIEW_MIME_TYPE = "image/jpeg";

/** A preview image's longer side, in pixels: what a Client may ask for, and the default. */
export const PREVIEW_MIN_EDGE_PX = 160;

export const PREVIEW_MAX_EDGE_PX = 1280;

/** A preview image is at most this many bytes; the Daemon lowers JPEG quality to fit. */
export const PREVIEW_MAX_FRAME_BYTES = 512 * 1024;

/** How the watching Client reaches the Host: `remote` is SSH, Remote Access or the Relay. */
export const PreviewLink = Schema.Literals(["local", "remote"]);

export type PreviewLink = typeof PreviewLink.Type;

/** The most frames a second the Daemon sends, by link. */
export const PREVIEW_MAX_FPS = { local: 10, remote: 2 } as const satisfies Record<
  PreviewLink,
  number
>;

/** The longer side the Daemon captures at for a Client that asked for `requested` pixels. */
export const previewEdge = (requested: number | null): number =>
  requested === null || !Number.isFinite(requested)
    ? PREVIEW_MAX_EDGE_PX
    : Math.min(PREVIEW_MAX_EDGE_PX, Math.max(PREVIEW_MIN_EDGE_PX, Math.round(requested)));

/** One image of the window an Agent Session last acted on. Its bytes follow as a blob. */
export class PreviewFrame extends Schema.Class<PreviewFrame>("PreviewFrame")({
  /** The JPEG, as binary side-chunks; never inline, so a frame never delays a JSON frame. */
  blobId: BlobId,
  bytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: PREVIEW_MAX_FRAME_BYTES })),
  /** The image's own size in pixels, its longer side within the edge asked for. */
  width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: PREVIEW_MAX_EDGE_PX })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: PREVIEW_MAX_EDGE_PX })),
  capturedAt: Timestamp,
  app: AppRef,
  /** Null for a capture of the whole screen (Hosts that can't capture one window). */
  window: Schema.NullOr(AppWindow),
}) {}

/** Why there is no frame now. */
export const PreviewIdleReason = Schema.Literals([
  /** The session has not acted on a window, or that window closed. */
  "no-window",
  "screen-locked",
  /** Computer use is no longer ready on this Host. */
  "not-ready",
]);

export type PreviewIdleReason = typeof PreviewIdleReason.Type;

export const PreviewItem = Schema.TaggedUnion({
  Frame: { frame: PreviewFrame },
  /** Capture stopped; frames resume by themselves when the reason passes. */
  Idle: { reason: PreviewIdleReason },
});

export type PreviewItem = typeof PreviewItem.Type;

const previewPayload = {
  sessionId: SessionId,
  /** The longer side wanted, in pixels; null for the largest. Clamped by `previewEdge`. */
  maxEdgePx: Schema.NullOr(Schema.Int),
};

/**
 * Live frames of the window `sessionId` last acted on (capability `computer-use.preview`:
 * Hosts with live capture). The Host captures only while a Client watches; ending the stream
 * unsubscribes. A frame is dropped, never queued, while the previous one is still being sent.
 */
export const WatchPreview = Rpc.make("computerUse.preview.watch", {
  payload: { ...previewPayload, link: PreviewLink },
  success: PreviewItem,
  error: Schema.Union([NotFound, Unsupported]),
  stream: true,
});

/**
 * The session's latest screenshot, for Hosts with no live capture and for a still thumbnail:
 * what its last computer use action saw. Null before the first, and where the Host can't take one.
 */
export const LatestPreview = Rpc.make("computerUse.preview.latest", {
  payload: previewPayload,
  success: Schema.NullOr(PreviewFrame),
  error: Schema.Union([NotFound, Unsupported]),
});

export class ComputerUseRpcs extends RpcGroup.make(
  GetComputerUse,
  WatchComputerUse,
  EnableComputerUse,
  DisableComputerUse,
  OpenComputerUseSetup,
  ListAllowedApps,
  RemoveAllowedApp,
  GetDesktopApp,
  WatchPreview,
  LatestPreview
) {}

/** Every computer use RPC: the SDK's Client leaves them out, as none is open to Extensions. */
export const COMPUTER_USE_RPC_TAGS = [
  "computerUse.status",
  "computerUse.watch",
  "computerUse.enable",
  "computerUse.disable",
  "computerUse.openSetup",
  "computerUse.allowedApps",
  "computerUse.removeAllowedApp",
  "computerUse.app",
  "computerUse.preview.watch",
  "computerUse.preview.latest",
] as const satisfies ReadonlyArray<RpcGroup.Rpcs<typeof ComputerUseRpcs>["_tag"]>;
