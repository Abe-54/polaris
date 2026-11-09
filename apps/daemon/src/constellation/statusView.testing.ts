import {
  Attempt,
  Constellation,
  ConstellationQuestion,
  OpenQuestion,
  TaskDefinition,
  TaskId,
} from "@polaris/protocol";
import { Struct } from "effect";
import { A, B, draft, planned, task } from "../engine/constellation.testing.ts";

export const P = TaskId.make("P");

export const P1 = TaskId.make("P1");

export const P2 = TaskId.make("P2");

const child = (id: TaskId) => new TaskDefinition(Struct.assign(task(id), { parent: P }));

const settled = (taskId: TaskId, id: string, state: "accepted" | "rejected") =>
  Attempt.make(Struct.assign(draft(taskId, id), { state }));

/** A accepted after a send-back, B working with a question, P1 accepted and P2 ready under P. */
export const mixedRecord = () => {
  const record = planned([task(A), task(B), task(P), child(P1), child(P2)]);

  const question = ConstellationQuestion.make({
    id: "feed",
    to: "lead",
    text: "Which feed?",
    blocking: false,
  });

  const graph = Constellation.make(
    Struct.assign(record.graph, {
      attempts: [
        settled(A, "a-old", "rejected"),
        settled(A, "a1", "accepted"),
        draft(B, "b1"),
        settled(P1, "p1", "accepted"),
      ],
      openQuestions: [
        OpenQuestion.make({
          attemptId: draft(B, "b1").id,
          question,
          askedAt: record.graph.updatedAt,
        }),
      ],
    })
  );

  return { ...record, graph };
};

/** The Task ids an outline lists, in order. */
export const listed = (outline: string) =>
  outline
    .split("\n")
    .flatMap((line) => /^\s*([A-Za-z0-9_-]+) · .+ · task revision/.exec(line)?.[1] ?? []);
