/**
 * The session's pending requests as the thread shows them: a permission with
 * its whole command or file, never cut short, and every structured question
 * with its options, so anything Home sends here can be answered here.
 */
import { ApprovalDecision, type ApprovalRequest } from "@polaris/protocol";
import { Match } from "effect";
import { approvalDetail, askLine } from "../home/model/lines.ts";

export interface RequestQuestion {
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string | null }>;
  readonly multiSelect: boolean;
}

export type RequestCard =
  | {
      readonly kind: "permission";
      readonly ask: string;
      /** Every line of what the Harness asked to run or change. */
      readonly detail: string | null;
    }
  | { readonly kind: "questions"; readonly questions: ReadonlyArray<RequestQuestion> }
  /** A Secret Request (ADR 0089): answered with a value or declined, never allowed. */
  | {
      readonly kind: "secret";
      readonly label: string;
      readonly reason: string | null;
      readonly placeholder: string | null;
    };

/** A question from a Daemon before ENG-450 carries only its title and first choices. */
const questionsOf = (approval: ApprovalRequest): ReadonlyArray<RequestQuestion> => {
  const asked = approval.questions ?? [];

  if (asked.length > 0) return asked;

  return [
    {
      header: "",
      question: approval.title,
      options: approval.options.map((label) => ({ label, description: null })),
      multiSelect: false,
    },
  ];
};

export const requestCard = (approval: ApprovalRequest): RequestCard =>
  Match.value(approval.kind).pipe(
    Match.when("question", (): RequestCard => ({
      kind: "questions",
      questions: questionsOf(approval),
    })),
    Match.when("secret", (): RequestCard => ({
      kind: "secret",
      label: approval.title,
      reason: approval.detail,
      placeholder: approval.placeholder ?? null,
    })),
    Match.orElse((): RequestCard => ({
      kind: "permission",
      ask: askLine(approval),
      detail: approvalDetail(approval)?.text ?? null,
    }))
  );

/** Picks per question, in order: chosen labels, or the typed answer as one entry. */
export type Picks = ReadonlyArray<ReadonlyArray<string>>;

/** Every question has an answer. */
export const answered = (approval: ApprovalRequest, picks: Picks) =>
  questionsOf(approval).every((_, index) => (picks[index] ?? []).some((pick) => pick !== ""));

/** Toggles a label for a multi-select question; replaces the pick for a single choice. */
export const pick = (picks: Picks, index: number, label: string, multiSelect: boolean): Picks => {
  const held = picks[index] ?? [];

  const next = multiSelect
    ? held.includes(label)
      ? held.filter((chosen) => chosen !== label)
      : [...held, label]
    : [label];

  return Array.from({ length: Math.max(picks.length, index + 1) }, (_, at) =>
    at === index ? next : (picks[at] ?? [])
  );
};

/** The Answer decision for every question, with a text form for Harnesses that read only that. */
export const answersDecision = (approval: ApprovalRequest, picks: Picks): ApprovalDecision => {
  const questions = questionsOf(approval);
  const answers = questions.map((_, index) => picks[index] ?? []);

  const text =
    questions.length === 1
      ? (answers[0]?.join(", ") ?? "")
      : questions
          .map(
            (q, index) =>
              `${q.header === "" ? q.question : q.header}: ${answers[index]?.join(", ") ?? ""}`
          )
          .join("\n");

  return ApprovalDecision.cases.Answer.make({ text, answers });
};

/** Headed input is asked each time: the Daemon refuses remembering it from anyone. */
export const offersAlwaysAllow = (request: ApprovalRequest) =>
  request.profileAttach === undefined && request.kind !== "headed-input";
