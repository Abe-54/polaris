import { describe, expect, test } from "bun:test";
import { ApprovalDecision, ApprovalQuestion, QuestionOption } from "@polaris/protocol";
import { request } from "./daemon.testing.ts";
import { offersAlwaysAllow, answered, answersDecision, pick, requestCard } from "./requests.ts";

const option = (label: string) => new QuestionOption({ label, description: null });

const twoQuestions = request({
  kind: "question",
  title: "Two questions",
  questions: [
    new ApprovalQuestion({
      header: "Scope",
      question: "Which packages?",
      options: [option("client"), option("mobile")],
      multiSelect: true,
    }),
    new ApprovalQuestion({
      header: "Tests",
      question: "Run them?",
      options: [option("Yes"), option("No")],
      multiSelect: false,
    }),
  ],
});

describe("pending requests in the thread", () => {
  test("a command past Home's inline limit keeps every line", () => {
    const detail = Array.from({ length: 9 }, (_, i) => `echo ${i} ${"y".repeat(50)}`).join("\n");
    const card = requestCard(request({ detail }));
    expect(card).toEqual({
      kind: "permission",
      ask: "Wants to run a command",
      detail: `$ ${detail}`,
    });
  });

  test("several questions are all asked, and answered per question", () => {
    const card = requestCard(twoQuestions);
    expect(card.kind === "questions" && card.questions.map((q) => q.question)).toEqual([
      "Which packages?",
      "Run them?",
    ]);

    let picks = pick([], 0, "client", true);
    picks = pick(picks, 0, "mobile", true);
    expect(answered(twoQuestions, picks)).toBe(false);
    picks = pick(picks, 1, "No", false);
    picks = pick(picks, 1, "Yes", false);
    expect(answered(twoQuestions, picks)).toBe(true);

    expect(answersDecision(twoQuestions, picks)).toEqual(
      ApprovalDecision.cases.Answer.make({
        answers: [["client", "mobile"], ["Yes"]],
        text: "Scope: client, mobile\nTests: Yes",
      })
    );
  });
});

test("P9-10: attach approval has no remembered action, ordinary tool approvals keep it", () => {
  expect(
    offersAlwaysAllow(
      request({
        kind: "tool",
        profileAttach: { pid: 42, command: "node app", runtime: "node", seconds: 5 },
      })
    )
  ).toBe(false);
  expect(offersAlwaysAllow(request({ kind: "tool" }))).toBe(true);
});

test("headed input is asked each time; an app approval can be always allowed", () => {
  expect(offersAlwaysAllow(request({ kind: "headed-input" }))).toBe(false);
  expect(offersAlwaysAllow(request({ kind: "app" }))).toBe(true);
});
