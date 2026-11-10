/** What both entry points export; each adds the transports its runtime has. */
export {
  type ApprovalResponse,
  type DispatchError,
  type HostError,
  mergeHosts,
  type Polaris,
  type PolarisOptions,
  type StartSessionInput,
  type SubscribeSessionOptions,
} from "./client.ts";

export { alwaysAllowable } from "./approvals.ts";

export type { ConnectError, OpenTransport } from "./connection.ts";

/** What an Extension announces in `hello`; never `approval.secret` (ADR 0089). */
export { SDK_CAPABILITIES } from "./connection.ts";

export {
  CommandRejected,
  ExtensionTokenRejected,
  HostUnreachable,
  NotFound,
  NotGranted,
  ProtocolMismatch,
  UnknownHost,
  VoiceError,
} from "./errors.ts";

export type { HostView, Session, SessionEntry } from "./hostView.ts";

export type { HostEntry } from "./link.ts";

export {
  decodePairing,
  encodePairing,
  InvalidPairing,
  PAIRING_PREFIX,
  type ParsedPairing,
  parsePairing,
} from "./pairing.ts";

export { AudioFailed, createPolarisWith, type PolarisClient } from "./promise.ts";

export type { SessionView, StreamingText, TurnEntry } from "./sessionView.ts";

export { type TranscribeError, type Transcript, VOICE_SAMPLE_RATE } from "./voice.ts";

export { webSocketTransport } from "./transport/websocket.ts";

export { SDK_VERSION, SUPPORTED_PROTOCOL } from "./version.ts";

/** The Harnesses Polaris can drive, by kind and product name. */
export { HARNESS_CATALOGUE, type HarnessEntry, harnessEntry } from "@polaris/protocol";

/** The mode a Daemon with these capabilities gets: `plan` becomes `supervised` without `session.plan-mode`. */
export { permissionModeFor } from "@polaris/protocol";

export type {
  AgentSession,
  ApprovalRequest,
  Capability,
  DesktopApp,
  GrantKind,
  HarnessKind,
  HostInfo,
  PermissionMode,
  SessionState,
  Turn,
  TurnItem,
  Workspace,
} from "@polaris/protocol";
