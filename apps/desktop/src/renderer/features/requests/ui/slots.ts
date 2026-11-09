/**
 * The props every Requests slot takes, so U2 (the send pane) and U3 (the send log) replace a file
 * without touching the layout.
 */
import type { Send } from "@polaris/protocol";
import type { RequestsSessionKey } from "../model/session.ts";

export interface RequestsSlotProps {
  readonly at: RequestsSessionKey;
  readonly hostKey: string;
  readonly workspaceId: string;
}

export interface SendPaneProps extends RequestsSlotProps {
  /** The latest send from this view; null until the first. */
  readonly latest: Send | null;
  /** A send is on its way; `latest` is the one before it. */
  readonly sending: boolean;
}
