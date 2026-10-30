/**
 * What the composer does in each Session State, and the commands it sends.
 * Mirrors the session machine's rules (`apps/daemon/src/engine/session.ts`) so
 * the composer never offers what the Daemon would refuse; a refusal still wins.
 */
import type {
  ApprovalRequest,
  AttachmentId,
  Capability,
  Command,
  PermissionMode,
  RequestId,
  SessionId,
  SessionState,
  TurnId,
  TurnStatus,
} from "@polaris/protocol";
import { Commands, Decisions } from "../../../commands.ts";
import { shortcutLabel } from "../../../../shared/chord.ts";
import { FIELD_CHORDS } from "../../../../shared/keymap.ts";
import { shellCommandOf } from "../../composer/index.ts";

export type ComposerMode =
  /** A new Turn: `SendTurn`. */
  | { readonly kind: "send" }
  /** Guidance for the Turn in flight: `Steer` (↵); ⌘↵ queues a follow-up instead. */
  | { readonly kind: "steer" }
  /** A Turn is in flight and can't be steered: ↵ queues a follow-up for after it. */
  | { readonly kind: "queue" }
  /** A question is open: the draft answers it in free text (`RespondToApproval` Answer). */
  | { readonly kind: "answer"; readonly requestId: RequestId }
  /** Nothing can be sent now; `reason` says why, as the placeholder. */
  | { readonly kind: "blocked"; readonly reason: string };

export interface ComposerContext {
  readonly state: SessionState;
  readonly lastTurn: TurnStatus | null;
  readonly pendingApprovals: number;
  /** The first open question, when every open request is a question; null otherwise. */
  readonly question: RequestId | null;
  /** The Daemon has `session.steer`. */
  readonly canSteer: boolean;
}

/** The first open question, when every open request is a question (else null). */
export const openQuestion = (pending: ReadonlyArray<ApprovalRequest>): RequestId | null =>
  pending.length > 0 && pending.every((r) => r.kind === "question")
    ? (pending[0]?.id ?? null)
    : null;

const blocked = (reason: string): ComposerMode => ({ kind: "blocked", reason });

const SEND: ComposerMode = { kind: "send" };

/** The composer's mode; the same checks, in the same order, as the machine's `takesTurn`. */
export const composerMode = (ctx: ComposerContext): ComposerMode => {
  if (ctx.state === "archived") return blocked("Unarchive this session to send a turn");

  if (ctx.state === "in-terminal") return blocked("In terminal · take it back to send a turn");

  if (ctx.question !== null) return { kind: "answer", requestId: ctx.question };

  if (ctx.lastTurn === "working") {
    if (ctx.pendingApprovals > 0) return blocked("Answer the request above to go on");

    return ctx.canSteer ? { kind: "steer" } : { kind: "queue" };
  }

  if (ctx.state === "starting") return blocked("Starting…");

  if (ctx.state === "needs-you" && ctx.pendingApprovals > 0)
    return blocked("Answer the request above to go on");

  return SEND;
};

const PLACEHOLDERS: Readonly<Record<Exclude<ComposerMode["kind"], "blocked">, string>> = {
  send: "Ask for a change",
  steer: "Steer this turn · {submit} to queue a follow-up",
  queue: "Queue a follow-up for after this turn",
  answer: "Or answer in your own words",
};

export const placeholderFor = (mode: ComposerMode): string =>
  mode.kind === "blocked"
    ? mode.reason
    : PLACEHOLDERS[mode.kind].replace("{submit}", shortcutLabel(FIELD_CHORDS.submit));

/** ⌘↵ queues a follow-up while a Turn runs (and ↵ does when it can't be steered). */
export const canQueue = (mode: ComposerMode) => mode.kind === "steer" || mode.kind === "queue";

export interface Draft {
  readonly text: string;
  readonly attachments: ReadonlyArray<AttachmentId>;
  /** A shell command (`!…`, shell mode): it runs as its own Turn, between Turns only. */
  readonly shell?: boolean;
}

/** A shell draft's command, or null for `!` alone; attachments stay in the composer. */
const shellCommand = (sessionId: SessionId, draft: Draft): Command | null => {
  const command = shellCommandOf(draft.text);

  return command === null ? null : Commands.RunShellCommand({ sessionId, command });
};

/** The command a submitted draft becomes, or null when there is nothing to send. */
export const submitCommand = (
  mode: ComposerMode,
  sessionId: SessionId,
  draft: Draft
): Command | null => {
  const text = draft.text.trim();

  if (mode.kind === "blocked" || mode.kind === "queue") return null;

  // Mid-Turn a shell command can't steer: the composer queues it for after the Turn.
  if (draft.shell === true) return mode.kind === "send" ? shellCommand(sessionId, draft) : null;

  if (mode.kind === "steer") {
    if (text === "" && draft.attachments.length === 0) return null;

    return draft.attachments.length === 0
      ? Commands.Steer({ sessionId, text })
      : Commands.Steer({ sessionId, text, attachments: draft.attachments });
  }

  if (mode.kind === "answer") {
    if (text === "") return null;

    return Commands.RespondToApproval({
      sessionId,
      requestId: mode.requestId,
      decision: Decisions.Answer({ text }),
    });
  }

  if (text === "" && draft.attachments.length === 0) return null;

  return Commands.SendTurn({ sessionId, prompt: text, attachments: draft.attachments });
};

/** A queued follow-up, sent as the next Turn once the one in flight ends. */
export const queuedCommand = (sessionId: SessionId, draft: Draft): Command | null => {
  if (draft.shell === true) return shellCommand(sessionId, draft);
  const prompt = draft.text.trim();

  if (prompt === "" && draft.attachments.length === 0) return null;

  return Commands.SendTurn({ sessionId, prompt, attachments: draft.attachments });
};

/** Esc while Working interrupts the Turn in flight; otherwise it does nothing. */
export const interruptCommand = (sessionId: SessionId, lastTurn: TurnStatus | null) =>
  lastTurn === "working" ? Commands.Interrupt({ sessionId }) : null;

export const continueCommand = (sessionId: SessionId) => Commands.Continue({ sessionId });

export const retryCommand = (sessionId: SessionId) => Commands.Retry({ sessionId });

export const resumeAtResetCommand = (sessionId: SessionId, resumeAtReset: boolean) =>
  Commands.SetResumeAtReset({ sessionId, resumeAtReset });

export const renameCommand = (sessionId: SessionId, title: string): Command | null => {
  const trimmed = title.trim();

  return trimmed === "" ? null : Commands.RenameSession({ sessionId, title: trimmed });
};

export const permissionCommand = (sessionId: SessionId, permissionMode: PermissionMode) =>
  Commands.SetPermissionMode({ sessionId, permissionMode });

/** `deleteMergedBranch` from Settings → Sessions; the Daemon never deletes an unmerged branch. */
export const archiveCommand = (sessionId: SessionId, deleteMergedBranch: boolean) =>
  Commands.ArchiveSession({ sessionId, deleteMergedBranch });

export interface ForkInput {
  readonly sessionId: SessionId;
  readonly fromSessionId: SessionId;
  readonly fromTurnId: TurnId;
  readonly harness: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly serviceTier?: "default" | "priority" | null;
}

export const forkCommand = (input: ForkInput) => Commands.ForkSession(input);

/** Permission modes as the picker lists them, least trust first. */
export const PERMISSION_MODES: ReadonlyArray<{
  readonly mode: PermissionMode;
  readonly label: string;
  readonly detail: string;
}> = [
  { mode: "plan", label: "Plan", detail: "Reads and plans, asks before editing" },
  { mode: "supervised", label: "Supervised", detail: "Asks before edits and commands" },
  { mode: "auto-edits", label: "Auto-edits", detail: "Edits freely, asks before commands" },
  { mode: "auto", label: "Auto", detail: "Runs freely, asks for risky actions" },
  { mode: "full-access", label: "Full access", detail: "Never asks" },
];

/** The modes a Host offers: Plan needs `session.plan-mode`. */
export const permissionModesOn = (capabilities: ReadonlyArray<Capability>) =>
  capabilities.includes("session.plan-mode")
    ? PERMISSION_MODES
    : PERMISSION_MODES.filter((p) => p.mode !== "plan");

export const permissionLabel = (mode: PermissionMode): string =>
  PERMISSION_MODES.find((p) => p.mode === mode)?.label ?? mode;
