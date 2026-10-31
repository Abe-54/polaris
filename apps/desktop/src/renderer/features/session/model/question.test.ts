import { describe, expect, test } from "bun:test";
import { ApprovalQuestion, ApprovalRequest, QuestionOption } from "@polaris/protocol";
import { approval } from "../../../store/fixtures.testing.ts";
import { answerDecision, questionAnswers, questionViews, typedStep } from "./question.ts";

describe("question answers", () => {
  test("the Harness's (Recommended) marker fills that row and leaves the label", () => {
    expect(questionAnswers(["Keep 20px (Recommended)", "Use 18px"])).toEqual([
      { label: "Keep 20px", value: "Keep 20px (Recommended)", recommended: true },
      { label: "Use 18px", value: "Use 18px", recommended: false },
    ]);
  });

  test("no marker, nothing filled; only the first marked one counts", () => {
    expect(questionAnswers(["A", "B"]).some((a) => a.recommended)).toBe(false);
    expect(
      questionAnswers(["A (recommended)", "B (Recommended)"]).map((a) => a.recommended)
    ).toEqual([true, false]);
  });
});

describe("several questions", () => {
  const ask = (...options: ReadonlyArray<ReadonlyArray<string>>) =>
    new ApprovalRequest({
      id: approval.id,
      sessionId: approval.sessionId,
      turnId: approval.turnId,
      openedAt: approval.openedAt,
      kind: "question",
      title: "Which scope?",
      detail: "Which scope?\nWhich tools?",
      options: [],
      questions: options.map(
        (labels, i) =>
          new ApprovalQuestion({
            header: `Q${i + 1}`,
            question: `Question ${i + 1}?`,
            options: labels.map((label) => new QuestionOption({ label, description: null })),
            multiSelect: i === 1,
          })
      ),
    });

  test("each is asked, and the picks answer each with the Harness's own labels", () => {
    const views = questionViews(ask(["Own (Recommended)", "Host"], ["Search", "Read", "Run"]));

    expect(views.map((v) => v.question)).toEqual(["Question 1?", "Question 2?"]);
    expect(answerDecision(views, [[0], [0, 2]])).toMatchObject({
      text: "Own (Recommended)\nSearch, Run",
      answers: [["Own (Recommended)"], ["Search", "Run"]],
    });
  });

  test("one with nothing to pick makes the request one question, answered in the composer", () => {
    const views = questionViews(ask(["Own", "Host"], []));

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ question: "Which scope?", answers: [] });
  });

  test("a typed answer answers only the question on screen, then moves on (ENG-677)", () => {
    const request = ask(["Own", "Host"], ["Search", "Read"], ["Yes", "No"], ["Now", "Later"]);
    const first = typedStep(request, null, "Only my sessions");

    if (first?.kind !== "next") throw new Error("the first typed answer should move on");
    expect(first.progress.step).toBe(1);

    // The card's picks for questions 2 and 3, then a typed answer to the last.
    const picked = { ...first.progress, step: 3, picks: [[], [1], [1], []] };

    expect(typedStep(request, picked, "Tomorrow")).toMatchObject({
      kind: "send",
      decision: { answers: [["Only my sessions"], ["Read"], ["No"], ["Tomorrow"]] },
    });
  });

  test("a single question keeps the composer's plain answer", () => {
    expect(typedStep(ask(["Own", "Host"]), null, "Mine")).toBeNull();
  });
});
