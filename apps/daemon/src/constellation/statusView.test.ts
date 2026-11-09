import { expect, test } from "bun:test";
import { DomainEvent, EventEnvelope, Sequence } from "@polaris/protocol";
import { A, B } from "../engine/constellation.testing.ts";
import { graphResult } from "./service.ts";
import { statusOutline, statusSince } from "./status.ts";
import { P, P1, P2, listed, mixedRecord } from "./statusView.testing.ts";

test("task narrows the outline to that Task's subtree and its questions", () => {
  const outline = statusOutline(mixedRecord(), undefined, undefined, { task: P });

  expect(listed(outline)).toEqual([P, P1, P2]);
  expect(outline).not.toContain("Which feed?");
  expect(statusOutline(mixedRecord(), undefined, undefined, { task: B })).toContain("Which feed?");
});

test("openOnly hides done Tasks but keeps a parent with open children", () => {
  const outline = statusOutline(mixedRecord(), undefined, undefined, { openOnly: true });

  expect(listed(statusOutline(mixedRecord()))).toEqual([A, B, P, P1, P2]);
  expect(listed(outline)).toEqual([B, P, P2]);
});

test("filtered JSON carries only the shown Tasks, their Attempts, questions and projections", () => {
  const record = mixedRecord();
  const result = graphResult(record, null, true, undefined, undefined, undefined, { task: P });

  expect(result.constellation?.tasks.map((t) => t.id)).toEqual([P, P1, P2]);
  expect(result.constellation?.attempts.map((a) => String(a.id))).toEqual(["p1"]);
  expect(result.constellation?.openQuestions).toEqual([]);
  expect(result.projections.map((p) => p.taskId)).toEqual([P, P1, P2]);
  expect(graphResult(record, null, true).constellation?.attempts).toHaveLength(4);
});

test("since with task lists only that Task's changes", () => {
  const record = mixedRecord();

  const events = [
    DomainEvent.cases.TaskCanceled.make({
      constellationId: record.graph.id,
      revision: 5,
      taskId: A,
      taskRevision: 1,
    }),
    DomainEvent.cases.AttemptProgressed.make({
      constellationId: record.graph.id,
      revision: 6,
      attemptId: record.graph.attempts.find((a) => a.taskId === B)!.id,
      attemptRevision: 0,
      note: "Feed parsed",
      completed: null,
      total: null,
    }),
  ].map(
    (event, i) =>
      new EventEnvelope({
        sequence: Sequence.make(i + 1),
        occurredAt: `2026-10-01T00:0${i}:00.000Z`,
        commandId: null,
        event,
      })
  );

  const text = statusSince(record, events, 4, undefined, undefined, { task: B });

  expect(text).toContain("changes since revision 4: 1");
  expect(text).toContain("B: progress · Feed parsed.");
  expect(text).not.toContain("A canceled.");
  expect(statusSince(record, events, 4)).toContain("A canceled.");
});
