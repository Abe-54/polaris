/** The Agent Session Traces reads: every call names it, and the Daemon resolves its checkout. */
import type { SessionId } from "@polaris/protocol";

export interface TracesSessionKey {
  readonly hostKey: string;
  readonly sessionId: SessionId;
  /** `self` reads Polaris's own Self-Traces; the session still authorizes the read. */
  readonly scope?: "self";
}

/** The key, built from its parts so a hook's dependencies stay strings. */
export const sessionKey = (
  hostKey: string,
  sessionId: SessionId,
  scope: "self" | undefined
): TracesSessionKey =>
  scope === undefined ? { hostKey, sessionId } : { hostKey, sessionId, scope };

/** One string per key: the open trace and its list are apart for the checkout and Self-Traces. */
export const scopedKey = (at: TracesSessionKey) =>
  `${at.hostKey}\u0000${at.sessionId}\u0000${at.scope ?? ""}`;
