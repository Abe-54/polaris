/**
 * A graph's open worker questions: unanswered, on a live Attempt. The Daemon keeps them in
 * `openQuestions`, apart from the Lead's delivery queue, which each digest empties (ENG-265).
 */
import { liveQuestions, OpenQuestion } from "@polaris/protocol";
import { Predicate } from "effect";
import type { ConstellationData } from "./types.ts";

export type OpenQuestionData = NonNullable<ConstellationData["openQuestions"]>[number];

/** The questions some notifications ask, as open questions: how previews seed a graph. */
export const questionsIn = (
  notifications: ConstellationData["pendingNotifications"]
): Array<OpenQuestion> =>
  notifications.flatMap(({ item, queuedAt }) =>
    Predicate.isTagged(item, "Question")
      ? [
          new OpenQuestion({
            attemptId: item.attemptId,
            question: item.question,
            askedAt: queuedAt,
          }),
        ]
      : []
  );

export const openQuestionsOf = (c: ConstellationData): ReadonlyArray<OpenQuestionData> =>
  liveQuestions(c.openQuestions ?? [], c.attempts);

/** The open questions addressed to the user, oldest first. */
export const userQuestions = (c: ConstellationData): ReadonlyArray<OpenQuestionData> =>
  openQuestionsOf(c)
    .filter((q) => q.question.to === "user")
    .toSorted((a, b) => a.askedAt.localeCompare(b.askedAt));

/** A user question as the Lead chat's card shows it: whose Task asks. */
export interface AskedQuestion {
  readonly attemptId: OpenQuestionData["attemptId"];
  readonly question: OpenQuestionData["question"];
  readonly taskId: string;
}

/**
 * The questions the Lead chat pins above its composer (ENG-345): addressed to the user, open,
 * on a live Attempt, each named by its Task.
 */
export const leadQuestions = (c: ConstellationData): ReadonlyArray<AskedQuestion> =>
  userQuestions(c).flatMap((q) => {
    const taskId = c.attempts.find((a) => a.id === q.attemptId)?.taskId;

    return taskId === undefined ? [] : [{ attemptId: q.attemptId, question: q.question, taskId }];
  });
