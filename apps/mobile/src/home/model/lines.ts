/**
 * How a Home row asks for an approval: concrete lines (product-design, rule/say-what-happened),
 * glossary words lowercase.
 */
import type { ApprovalRequest } from "@polaris/protocol";
import { middleCut, withoutOwnCd } from "@polaris/protocol/relay";
import { Match } from "effect";
import type { Session } from "../feed/fold.ts";

/** A "Ready to review" session: a Turn after the last accepted one. */
export const hasUnreviewedTurns = (session: Session) =>
  session.turnCount > 0 && (session.acceptedThroughIndex ?? -1) < session.turnCount - 1;

/** The yellow line above an approval's detail: what the agent wants. */
export const askLine = (approval: ApprovalRequest): string =>
  Match.value(approval.kind).pipe(
    Match.when("command", () => "Wants to run a command"),
    Match.when("file-change", () => "Wants to change files"),
    Match.when("tool", () => "Wants to use a tool"),
    Match.when("question", () => "Asks"),
    Match.when("secret", () => "Asks for a secret"),
    Match.when("app", () => "Wants to use an app"),
    Match.when("headed-input", () => "Wants headed input"),
    Match.when("computer-use", () => "Wants computer use"),
    Match.exhaustive
  );

/** What an approval asks for, whole: Home never offers Approve on a part of it. */
export interface ApprovalDetail {
  /** The command, file or tool as the Harness named it, every line. */
  readonly text: string;
  /** Too long to read in a row: approve it from the agent session, where it is shown in full. */
  readonly tooLong: boolean;
  /** What the row shows of a long one: cut in the middle, so its start and end both show. */
  readonly preview: string;
}

/** More than this, in lines or characters, is answered in the agent session. */
export const INLINE_LINES = 4;

export const INLINE_CHARACTERS = 280;

/** About four lines of the row's mono well. */
export const PREVIEW_CHARACTERS = 140;

const previewOf = (text: string): string => {
  const lines = text.split("\n");

  const kept =
    lines.length > INLINE_LINES ? [...lines.slice(0, 2), "…", ...lines.slice(-1)] : lines;

  return middleCut(kept.join("\n"), PREVIEW_CHARACTERS);
};

/** `cwd` is the agent session's: a command's leading `cd` into it is dropped (ENG-590). */
export const approvalDetail = (
  approval: ApprovalRequest,
  cwd: string | null = null
): ApprovalDetail | null => {
  const raw = (approval.detail ?? approval.title).trim();

  if (raw === "") return null;
  const command = approval.kind === "command";
  const shown = command && cwd !== null ? withoutOwnCd(raw, [cwd]) : raw;
  const text = command && !shown.startsWith("$ ") ? `$ ${shown}` : shown;
  const tooLong = text.split("\n").length > INLINE_LINES || text.length > INLINE_CHARACTERS;

  return { text, tooLong, preview: tooLong ? previewOf(text) : text };
};

/** A question with one single-choice question and its choices, answered by a chip. */
export interface QuickQuestion {
  readonly text: string;
  readonly choices: ReadonlyArray<string>;
}

export const quickQuestion = (approval: ApprovalRequest): QuickQuestion | null => {
  if (approval.kind !== "question") return null;
  const questions = approval.questions ?? [];
  const [only] = questions;

  if (questions.length > 1) return null;

  if (only === undefined) return { text: approval.title, choices: approval.options };

  if (only.multiSelect) return { text: only.question, choices: [] };

  return { text: only.question, choices: only.options.map((option) => option.label) };
};
