/**
 * What each Home row says under its title, and how an approval is asked: concrete lines
 * (product-design, rule/say-what-happened), glossary words lowercase.
 */
import type { ApprovalRequest } from "@polaris/protocol";
import { Match } from "effect";
import type { Session } from "../feed/fold.ts";
import type { SessionRow } from "./home.ts";

export type Tone = "subtle" | "failed" | "needs-you";

export interface Line {
  readonly text: string;
  readonly tone: Tone;
}

const turnOf = (session: Session): number => session.currentUserTurn?.number ?? session.turnCount;

const firstLine = (text: string | null): string | null => {
  const line = text
    ?.split("\n")
    .find((part) => part.trim() !== "")
    ?.trim();

  return line === undefined || line === "" ? null : line;
};

/** A "Ready to review" session: a Turn after the last accepted one. */
export const hasUnreviewedTurns = (session: Session) =>
  session.turnCount > 0 && (session.acceptedThroughIndex ?? -1) < session.turnCount - 1;

const join = (...parts: ReadonlyArray<string | null>) =>
  parts.filter((part): part is string => part !== null && part !== "").join(" · ");

const idleWords = (session: Session) => (hasUnreviewedTurns(session) ? "Ready to review" : "Idle");

/** The second line of a working or recent row. `withHost` adds the Host when there are several. */
export const statusLine = (row: SessionRow, withHost: boolean): Line => {
  const { session } = row;
  const host = withHost ? row.hostName : null;
  const turn = session.turnCount > 0 ? `turn ${turnOf(session)}` : null;

  return Match.value(session.state).pipe(
    Match.when("failed", () => ({
      text: join("Failed", firstLine(session.lastError), host),
      tone: "failed" as const,
    })),
    Match.when("limited", () => ({
      text: join("At its usage limit", host),
      tone: "subtle" as const,
    })),
    Match.when("needs-you", () => ({
      text: join("Needs you", turn, host),
      tone: "needs-you" as const,
    })),
    Match.whenOr("starting", "working", () => ({
      text: join(firstLine(row.replyPreview) ?? "Working", turn, host),
      tone: "subtle" as const,
    })),
    Match.when("in-terminal", () => ({
      text: join("In the terminal", turn, host),
      tone: "subtle" as const,
    })),
    Match.when("dormant", () => ({ text: join("Dormant", turn, host), tone: "subtle" as const })),
    Match.orElse(() => ({ text: join(idleWords(session), turn, host), tone: "subtle" as const }))
  );
};

/** The yellow line above an approval's detail: what the agent wants. */
export const askLine = (approval: ApprovalRequest): string =>
  Match.value(approval.kind).pipe(
    Match.when("command", () => "Wants to run a command"),
    Match.when("file-change", () => "Wants to change files"),
    Match.when("tool", () => "Wants to use a tool"),
    Match.when("question", () => "Asks"),
    Match.when("secret", () => "Asks for a secret"),
    Match.exhaustive
  );

/** What an approval asks for, whole: Home never offers Approve on a part of it. */
export interface ApprovalDetail {
  /** The command, file or tool as the Harness named it, every line. */
  readonly text: string;
  /** Too long to read in a row: approve it from the agent session, where it is shown in full. */
  readonly tooLong: boolean;
}

/** More than this, in lines or characters, is answered in the agent session. */
export const INLINE_LINES = 4;

export const INLINE_CHARACTERS = 280;

export const approvalDetail = (approval: ApprovalRequest): ApprovalDetail | null => {
  const raw = (approval.detail ?? approval.title).trim();

  if (raw === "") return null;
  const text = approval.kind === "command" && !raw.startsWith("$ ") ? `$ ${raw}` : raw;

  return {
    text,
    tooLong: text.split("\n").length > INLINE_LINES || text.length > INLINE_CHARACTERS,
  };
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
