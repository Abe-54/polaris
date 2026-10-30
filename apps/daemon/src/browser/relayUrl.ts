import type { SessionId } from "@polaris/protocol";

/** The relay URL a session's agent-browser connects to; its last segment is the token. */
export const cdpRelayUrl = (port: number, sessionId: SessionId, token: string): string =>
  `ws://127.0.0.1:${port}/browser/${encodeURIComponent(sessionId)}/${token}`;
