/**
 * A computer use approval on the phone (Paper CU4's sheet): "Use ‹app›?" with Allow once,
 * Always allow on ‹host› and Deny; headed input with Allow once and Deny only.
 */
import type { ApprovalRequest } from "@polaris/protocol";
import type { Reply } from "../home/model/respond.ts";

export interface ComputerUseAnswer {
  readonly label: string;
  readonly reply: Reply;
  readonly kind: "filled" | "plain" | "quiet";
}

export interface ComputerUseView {
  readonly title: string;
  /** "Claude Code · on Mac Studio". */
  readonly who: string;
  readonly reason: string | null;
  /** For headed input: how the user takes over. */
  readonly takeOver: string | null;
  readonly answers: ReadonlyArray<ComputerUseAnswer>;
}

export const isComputerUse = (request: Pick<ApprovalRequest, "kind">) =>
  request.kind === "app" || request.kind === "headed-input";

const ONCE: ComputerUseAnswer = { label: "Allow once", reply: { kind: "approve" }, kind: "filled" };

const DENY: ComputerUseAnswer = { label: "Deny", reply: { kind: "deny" }, kind: "quiet" };

export const computerUseView = (
  request: Pick<ApprovalRequest, "kind" | "app" | "title" | "detail">,
  harness: string,
  host: string
): ComputerUseView => {
  const app = request.app?.name;
  // Without an app on the request, its title still names it.
  const reason = request.detail ?? (app === undefined ? request.title : null);

  return request.kind === "headed-input"
    ? {
        title: "Take mouse and keyboard?",
        who: `${harness} · ${app === undefined ? "" : `${app} `}on ${host}`,
        reason,
        takeOver: `The pointer moves on its own while ${harness} works. Touch the mouse or keyboard on ${host} to take over; ${harness} pauses and is told.`,
        answers: [ONCE, DENY],
      }
    : {
        title: `Use ${app ?? "an app"}?`,
        who: `${harness} · on ${host}`,
        reason,
        takeOver: null,
        answers: [
          ONCE,
          { label: `Always allow on ${host}`, reply: { kind: "always" }, kind: "plain" },
          DENY,
        ],
      };
};
