/**
 * The words of a computer use approval (Paper CU4): an app approval asks for the app, for this
 * agent session or always on the Host; headed input asks for the real pointer, once only.
 */
import type { ApprovalRequest } from "@polaris/protocol";

export interface AppApprovalView {
  readonly headline: string;
  readonly reason: string | null;
  /** The pointer's take-over note, for headed input only. */
  readonly takeOver: string | null;
  /** "Always allow on ‹host›", or null where it is never offered. */
  readonly always: string | null;
  readonly footnote: string;
}

/** The app's name, or the request's title when the Daemon sent no app. */
export const appNameOf = (request: Pick<ApprovalRequest, "app" | "title">): string =>
  request.app?.name ?? request.title;

export const appApprovalView = (
  request: Pick<ApprovalRequest, "kind" | "app" | "title" | "detail">,
  who: string,
  host: string
): AppApprovalView =>
  request.kind === "headed-input"
    ? {
        headline: `${who} wants your mouse and keyboard`,
        reason: request.detail,
        takeOver: `While it works, the pointer moves on its own. Touch the mouse or keyboard to take over; ${who} pauses and is told.`,
        always: null,
        footnote: "Asked each time it's needed.",
      }
    : {
        headline: `${who} wants to use ${appNameOf(request)}`,
        reason: request.detail,
        takeOver: null,
        always: `Always allow on ${host}`,
        footnote: `Once lasts for this agent session. Always applies to every agent session on ${host}.`,
      };
