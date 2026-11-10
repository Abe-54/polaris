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

/** The app's name; "an app" when the request carries none (its title then says which). */
export const appNameOf = (request: Pick<ApprovalRequest, "app">): string =>
  request.app?.name ?? "an app";

/** The agent's reason; the request's title when it carries no app, so the app is still named. */
const reasonOf = (request: Pick<ApprovalRequest, "app" | "title" | "detail">) =>
  request.detail ?? (request.app === undefined ? request.title : null);

export const appApprovalView = (
  request: Pick<ApprovalRequest, "kind" | "app" | "title" | "detail">,
  who: string,
  host: string
): AppApprovalView =>
  request.kind === "headed-input"
    ? {
        headline: `${who} wants your mouse and keyboard`,
        reason: reasonOf(request),
        takeOver: `While it works, the pointer moves on its own. Touch the mouse or keyboard to take over; ${who} pauses and is told.`,
        always: null,
        footnote: "Asked each time it's needed.",
      }
    : {
        headline: `${who} wants to use ${appNameOf(request)}`,
        reason: reasonOf(request),
        takeOver: null,
        always: `Always allow on ${host}`,
        footnote: `Once lasts for this agent session. Always applies to every agent session on ${host}.`,
      };
