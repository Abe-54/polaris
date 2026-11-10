import "../../../test/dom.testing.ts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { AnswerAction, AttemptId, ConstellationQuestion, OpenQuestion } from "@polaris/protocol";
import { type AnswerInput, installConstellationClient, type Outcome } from "../client.ts";
import { B1_QUESTION, C1 } from "../../sessions/preview/fixtures.ts";
import { startedRecord } from "../model/fold.ts";
import { LeadQuestions } from "./questions.tsx";

const sent: Array<{ readonly hostKey: string; readonly input: AnswerInput }> = [];

/** A Daemon that answers every `answer` with `outcome` and records what it was sent. */
const daemon = (outcome: Outcome) => {
  const refuse = () => Promise.resolve<Outcome>({ ok: false, message: "", fix: null });

  installConstellationClient({
    answer: (hostKey, input) => {
      sent.push({ hostKey, input });

      return Promise.resolve(outcome);
    },
    review: refuse,
    dispatch: refuse,
    message: refuse,
    setState: refuse,
    startWorker: refuse,
  });
};

beforeEach(() => {
  sent.length = 0;
  daemon({ ok: true, summary: "Answered" });
});

afterEach(cleanup);

const B2_TO_LEAD = new OpenQuestion({
  attemptId: AttemptId.make("c1-B2-1"),
  question: new ConstellationQuestion({
    id: "q-b2-lead",
    to: "lead",
    text: "Which base should I use?",
    blocking: false,
  }),
  askedAt: "2026-10-01T12:00:00Z",
});

/** C1 with B1's question to the user and B2's to the Lead. */
const record = () =>
  startedRecord(
    { ...C1.constellation, openQuestions: [...(C1.constellation.openQuestions ?? []), B2_TO_LEAD] },
    1
  );

const openAnswer = (text: string) => {
  render(<LeadQuestions hostKey="local" record={record()} />);
  fireEvent.click(screen.getByRole("button", { name: "Answer" }));
  const field = screen.getByLabelText("Answer B1");
  fireEvent.change(field, { target: { value: text } });

  return field;
};

test("the Lead chat shows only the questions addressed to the user, named by their Task", () => {
  render(<LeadQuestions hostKey="local" record={record()} />);

  const shown = screen.getAllByTestId("lead-question");

  expect(shown).toHaveLength(1);
  expect(shown[0]?.textContent).toContain("B1 asks you");
  expect(screen.getByText(B1_QUESTION.text)).not.toBeNull();
  expect(screen.queryByText("Which base should I use?")).toBeNull();
});

test("an answer goes to the Lead's Host as the user's answer to that question", async () => {
  const field = openAnswer("  Yes, for one turn  ");
  fireEvent.keyDown(field, { key: "Enter", metaKey: true });

  await waitFor(() => expect(sent).toHaveLength(1));

  expect(sent[0]?.hostKey).toBe("local");
  expect(sent[0]?.input.constellationId).toBe(C1.constellation.id);
  expect(sent[0]?.input.action).toEqual(
    AnswerAction.cases.Question.make({
      attemptId: AttemptId.make("c1-B1-1"),
      questionId: B1_QUESTION.id,
      text: "Yes, for one turn",
    })
  );
  await waitFor(() => expect(screen.queryByLabelText("Answer B1")).toBeNull());
});

test("a refused answer keeps the field and its text", async () => {
  daemon({ ok: false, message: "Question closed", fix: null });
  openAnswer("Yes");
  fireEvent.click(screen.getByRole("button", { name: "Send to B1" }));

  await waitFor(() => expect(sent).toHaveLength(1));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send to B1" }).hasAttribute("disabled")).toBe(false)
  );
  expect(screen.getByDisplayValue("Yes")).toBe(screen.getByLabelText("Answer B1"));
});
