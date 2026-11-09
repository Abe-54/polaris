/** The Agent Session Requests acts for: every call names it, and the Daemon resolves its checkout. */
import type { SessionId } from "@polaris/protocol";

export interface RequestsSessionKey {
  readonly hostKey: string;
  readonly sessionId: SessionId;
}

/** One string per key, for maps and hook dependencies. */
export const sessionString = (at: RequestsSessionKey) => `${at.hostKey}\u0000${at.sessionId}`;
