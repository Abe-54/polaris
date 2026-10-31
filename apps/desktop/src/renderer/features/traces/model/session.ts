/** The Agent Session Traces reads: every call names it, and the Daemon resolves its checkout. */
import type { SessionId } from "@polaris/protocol";

export interface TracesSessionKey {
  readonly hostKey: string;
  readonly sessionId: SessionId;
}
