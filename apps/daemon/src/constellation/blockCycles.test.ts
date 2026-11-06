import { expect, test } from "bun:test";
import {
  ConstellationEvent,
  PlanOperation,
  ReviewAction,
  SessionId,
  Task,
  TaskDefinition,
  TaskId,
} from "@polaris/protocol";
import { Struct } from "effect";
import { decideConstellation } from "../engine/constellation.ts";
import {
  A,
  B,
  C,
  CID,
  apply,
  ctx,
  dispatched,
  draft,
  foldDecision,
  planned,
  task,
} from "../engine/constellation.testing.ts";

const X = TaskId.make("X");

const P = TaskId.make("P");

const block = (record: ReturnType<typeof planned>, id = A, on = B) => {
  const attempt = record.graph.attempts.findLast((a) => a.taskId === id)!;

  return decideConstellation(
    record,
    C.WorkerBlock.make({
      constellationId: CID,
      attemptId: attempt.id,
      on: [on],
      reason: "Wait for feed",
    }),
    ctx({ binding: { kind: "session", sessionId: attempt.sessionId } })
  );
};

const edit = (record: ReturnType<typeof planned>, id: TaskId, deps: TaskId[]) =>
  decideConstellation(
    record,
    C.Plan.make({
      constellationId: CID,
      operations: [
        PlanOperation.cases.Edit.make({
          taskId: id,
          revision: record.graph.tasks.find((t) => t.id === id)!.revision,
          task: task(id, deps),
        }),
      ],
    }),
    ctx()
  );

const waiting = (tasks = [task(A), task(B), task(X)]) => {
  let record = dispatched(planned(tasks));
  record = dispatched(record, draft(B, "b", SessionId.make("b")));

  return apply(
    record,
    C.WorkerBlock.make({
      constellationId: CID,
      attemptId: draft().id,
      on: [B],
      reason: "Feed",
    }),
    ctx({ binding: { kind: "session", sessionId: draft().sessionId } })
  );
};

const childOfParent = new TaskDefinition(Struct.assign(task(B), { parent: P }));

test.each([
  ["second mutual block is rejected atomically", undefined, A],
  [
    "mixed dependency and block paths reject transitive blocks",
    [task(A), task(B), task(X, [A])],
    X,
  ],
])("%s", (_name, tasks, target) => {
  const decision = block(waiting(tasks), B, target);
  expect(decision.rejection?.findings[0]?.code).toBe("E-BLOCK-CYCLE");
  expect(decision.events).toEqual([]);
});

test.each([
  ["plan edits name the block edge of a direct cycle", [task(A), task(B), task(X, [A])], B, [A]],
  [
    "plan edits name the block edge of a transitive cycle",
    [task(A), task(B), task(X, [A])],
    B,
    [X],
  ],
  [
    "block-closing parent edits include inherited dependencies and completion edges",
    [task(A), task(P), childOfParent],
    P,
    [A],
  ],
])("%s", (_name, tasks, id, deps) => {
  const decision = edit(waiting(tasks), id, deps);
  expect(decision.rejection?.findings.find((f) => f.code === "E-DEP-CYCLE")?.message).toContain(
    "block A → B"
  );
  expect(decision.events).toEqual([]);
});

test("stopping a blocked Attempt removes its wait edges from both guards", () => {
  const record = waiting();

  const stopped = apply(
    record,
    C.Review.make({
      constellationId: CID,
      attemptId: draft().id,
      revision: record.graph.attempts[0]!.revision,
      action: ReviewAction.cases.Stop.make({ reason: "Use another approach" }),
    })
  );

  expect(block(stopped, B, A).rejection).toBeNull();
  expect(edit(stopped, B, [A]).rejection).toBeNull();
});

test("accepted Tasks do not contribute dependency wait edges", () => {
  const record = waiting();
  const feed = record.graph.attempts.find((a) => a.taskId === B)!;

  const accepted = foldDecision(record, [
    ConstellationEvent.cases.AttemptAccepted.make({
      constellationId: CID,
      revision: record.graph.revision + 1,
      attemptId: feed.id,
      attemptRevision: feed.revision + 1,
      mergedHead: "head",
      receipts: [],
      evidence: "asserted",
    }),
  ]);

  expect(edit(accepted, B, [A]).rejection).toBeNull();

  const changed = apply(
    accepted,
    C.Plan.make({
      constellationId: CID,
      operations: [PlanOperation.cases.Edit.make({ taskId: B, revision: 0, task: task(B, [A]) })],
    })
  );

  expect(edit(changed, X, [B]).rejection).toBeNull();
});

test("legacy block cycles allow unrelated edits and edits that remove cycle edges", () => {
  const record = waiting();

  const legacy = foldDecision(record, [
    ConstellationEvent.cases.TaskEdited.make({
      constellationId: CID,
      revision: record.graph.revision + 1,
      task: Task.make(
        Struct.assign(
          record.graph.tasks.find((t) => t.id === B)!,
          { deps: [A], revision: 1 }
        )
      ),
    }),
  ]);

  expect(edit(legacy, X, []).rejection).toBeNull();
  expect(edit(legacy, B, []).rejection).toBeNull();
  expect(edit(legacy, X, [A]).rejection).toBeNull();
  expect(edit(legacy, A, [X]).rejection).toBeNull();

  const cyclicBatch = decideConstellation(
    legacy,
    C.Plan.make({
      constellationId: CID,
      operations: [
        PlanOperation.cases.Edit.make({ taskId: A, revision: 0, task: task(A, [X]) }),
        PlanOperation.cases.Edit.make({ taskId: X, revision: 0, task: task(X, [A]) }),
      ],
    }),
    ctx()
  );

  expect(cyclicBatch.rejection?.findings.some((f) => f.code === "E-DEP-CYCLE")).toBe(true);

  const cancel = decideConstellation(
    legacy,
    C.Plan.make({
      constellationId: CID,
      operations: [
        PlanOperation.cases.Cancel.make({ taskId: X, revision: 0 }),
        PlanOperation.cases.Edit.make({ taskId: B, revision: 1, task: task(B) }),
      ],
    }),
    ctx()
  );

  expect(cancel.rejection).toBeNull();
});

test("Plan reports one finding for each directed cycle, regardless of its newly added edges", () => {
  const Y = TaskId.make("Y");
  const record = planned([task(A), task(B), task(X), task(Y)]);

  const edits: ReadonlyArray<readonly [TaskId, TaskId]> = [
    [A, B],
    [B, A],
    [X, Y],
    [Y, X],
  ];

  const result = decideConstellation(
    record,
    C.Plan.make({
      constellationId: CID,
      operations: edits.map(([id, dep]) =>
        PlanOperation.cases.Edit.make({ taskId: id, revision: 0, task: task(id, [dep]) })
      ),
    }),
    ctx()
  );

  expect(result.rejection?.findings.filter((f) => f.code === "E-DEP-CYCLE")).toHaveLength(2);
  expect(result.events).toEqual([]);
});
