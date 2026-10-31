/**
 * Needs You and the main process: publish the inbox summary (menu bar star, Dock badge,
 * notifications), and act on what the star and notifications send back.
 */
import type { ApprovalRequest, SessionId } from "@polaris/protocol";
import type { AppEvent } from "../../../shared/api.ts";
import type { NeedsYouSummary } from "../../../shared/needsYou.ts";
import type { ShellActions } from "../../routes/navigation.ts";
import { polaris } from "../bridge.ts";
import { answer, approve, deny } from "./respond.ts";

let last = "";

/** Sends the summary when it changed; the main process diffs requests itself. */
export const publishSummary = (summary: NeedsYouSummary) => {
  const text = JSON.stringify(summary);

  if (text === last) return;
  last = text;
  void polaris().request("needsYou.publish", summary);
};

/** The request still pending in the Host's read model; undefined once it's resolved. */
export type FindRequest = (
  hostKey: string,
  sessionId: SessionId,
  requestId: string
) => ApprovalRequest | undefined;

/** An app event from the star or a notification. */
export const onNeedsYouEvent = (
  event: Extract<AppEvent, { kind: "needs-you" }>,
  actions: Pick<ShellActions, "selectSession" | "showSidebar">,
  find: FindRequest
) => {
  // SAFETY: the main process echoes session ids the renderer published.
  const sessionId = event.sessionId as SessionId;
  const target = { hostKey: event.hostKey, sessionId };

  if (event.action === "open") {
    actions.selectSession(target);

    return;
  }

  if (event.action === "answer") {
    void answer({ ...target, requestId: event.requestId }, event.text);

    return;
  }

  // Approve sends what the request's card would, so the request itself is needed.
  const request = find(event.hostKey, sessionId, event.requestId);

  if (request === undefined) return;

  if (event.action === "approve") void approve({ ...target, request });
  else void deny({ ...target, request });
};
