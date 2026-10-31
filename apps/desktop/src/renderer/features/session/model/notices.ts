/**
 * The composer's notice strip (DESIGN.md, Chrome redesign: The composer): what there is to
 * know now, by priority. The strip shows the first and keeps the rest behind "+n".
 */
import type { ApprovalRequest } from "@polaris/protocol";
import { CONTEXT_NEARLY_FULL } from "./meta.ts";
import type { Outgoing } from "./outbox.ts";
import type { TodoList } from "./todoList.ts";
import { dataWants } from "../../data/approval/model.ts";

export type Notice =
  | { readonly kind: "approval"; readonly request: ApprovalRequest }
  | { readonly kind: "working" }
  | { readonly kind: "todo"; readonly list: TodoList }
  | { readonly kind: "queued"; readonly entries: ReadonlyArray<Outgoing> }
  | { readonly kind: "context"; readonly share: number }
  | { readonly kind: "limited"; readonly resetsAt: string | null };

export interface NoticeInput {
  readonly approvals: ReadonlyArray<ApprovalRequest>;
  readonly working: boolean;
  /** The agent's todo list while its Turn works (`todoList`). */
  readonly todo: TodoList | null;
  readonly outbox: ReadonlyArray<Outgoing>;
  /** The share of the context window in use; null when the window is unknown. */
  readonly contextShare: number | null;
  /** The user closed the nearly-full notice at this share or above it. */
  readonly contextDismissedAt: number | null;
  readonly limited: boolean;
  readonly resetsAt: string | null;
}

const nearlyFull = (input: NoticeInput): number | null => {
  const share = input.contextShare;

  if (share === null || share < CONTEXT_NEARLY_FULL) return null;

  return input.contextDismissedAt !== null && share <= input.contextDismissedAt ? null : share;
};

/** Every notice that applies, highest priority first; the Goal joins once Goals exist (ENG-503). */
export const notices = (input: NoticeInput): ReadonlyArray<Notice> => {
  const queued = input.outbox.filter((o) => o.kind === "queued" && o.status === "waiting");
  const share = nearlyFull(input);
  const first = input.approvals[0];

  return [
    first === undefined ? null : { kind: "approval" as const, request: first },
    input.working ? { kind: "working" as const } : null,
    input.todo === null ? null : { kind: "todo" as const, list: input.todo },
    queued.length === 0 ? null : { kind: "queued" as const, entries: queued },
    share === null ? null : { kind: "context" as const, share },
    input.limited ? { kind: "limited" as const, resetsAt: input.resetsAt } : null,
  ].filter((n) => n !== null);
};

export interface StripLayout {
  /** The rows always shown: the top notice, and the todo list under Working. */
  readonly shown: ReadonlyArray<Notice>;
  /** The rest, behind "+n". */
  readonly behind: ReadonlyArray<Notice>;
}

/** One notice at a time, except that Working and the todo list share the strip. */
export const stripLayout = (all: ReadonlyArray<Notice>): StripLayout => {
  const [top, next] = all;
  const shared = top?.kind === "working" && next?.kind === "todo";
  const count = top === undefined ? 0 : shared ? 2 : 1;

  return { shown: all.slice(0, count), behind: all.slice(count) };
};

const WANTS: Readonly<Record<ApprovalRequest["kind"], string>> = {
  command: "wants to run",
  "file-change": "wants to change files",
  tool: "wants to use a tool",
  question: "has a question",
  secret: "is asking for a secret",
};

/**
 * How the strip announces a request. It never decides one: the strip truncates, so Approve and
 * Deny stay on the full card in the conversation, where the whole request is shown.
 */
export const approvalNotice = (request: ApprovalRequest) => {
  return {
    wants: dataWants(request) ?? WANTS[request.kind],
    shown: request.kind === "command" ? request.detail : null,
  };
};
