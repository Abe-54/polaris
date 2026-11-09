import { describe, expect, test } from "bun:test";
import {
  AnswerAction,
  HarnessSelection,
  ModelId,
  PlanOperation,
  TaskDefinition,
  TaskId,
  type TaskPatch,
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
  planned,
  task,
} from "../engine/constellation.testing.ts";

const P = TaskId.make("P");

const rich = new TaskDefinition({
  id: A,
  title: "Feed",
  kind: "task",
  deps: [B],
  area: ["apps/daemon"],
  brief: "Build the feed",
  criteria: ["Feed streams"],
  suggested: new HarnessSelection({ model: ModelId.make("fable") }),
  group: "Engine",
});

const base = () => planned([task(B), task(P), rich]);

const edit = (record: ReturnType<typeof planned>, patch: TaskPatch) =>
  apply(
    record,
    C.Plan.make({
      constellationId: CID,
      operations: [PlanOperation.cases.Edit.make({ taskId: A, revision: 0, task: patch })],
    })
  );

const taskA = (record: ReturnType<typeof planned>) => record.graph.tasks.find((t) => t.id === A)!;

const kept = {
  title: "Feed",
  deps: [B],
  area: ["apps/daemon"],
  brief: "Build the feed",
  criteria: ["Feed streams"],
  group: "Engine",
};

describe("Edit is a partial update (ENG-412)", () => {
  test("fields the Lead leaves out keep their values", () => {
    const after = taskA(edit(base(), { parent: P }));

    expect(after).toMatchObject({ ...kept, parent: P, revision: 1 });
    expect(after.suggested?.model).toBe(ModelId.make("fable"));
  });

  test("null and [] clear a field", () => {
    const after = taskA(
      edit(base(), {
        deps: [],
        area: null,
        brief: null,
        criteria: [],
        suggested: null,
        group: null,
      })
    );

    expect(after).toMatchObject({
      title: "Feed",
      deps: [],
      area: [],
      brief: "",
      criteria: [],
      suggested: null,
      group: null,
    });
  });

  test("an Edit that leaves the brief out sends no brief to the working worker", () => {
    const record = dispatched(
      planned([new TaskDefinition(Struct.assign(rich, { deps: [] }))]),
      draft(A)
    );

    const decision = decideConstellation(
      record,
      C.Plan.make({
        constellationId: CID,
        operations: [
          PlanOperation.cases.Edit.make({ taskId: A, revision: 0, task: { title: "Feed v2" } }),
        ],
      }),
      ctx()
    );

    expect(decision.events.map((e) => e._tag)).toEqual(["TaskEdited"]);
  });

  test("an id that names another Task is still refused as a rename", () => {
    const decision = decideConstellation(
      base(),
      C.Plan.make({
        constellationId: CID,
        operations: [PlanOperation.cases.Edit.make({ taskId: A, revision: 0, task: { id: B } })],
      }),
      ctx()
    );

    expect(decision.rejection?.findings.map((f) => f.code)).toEqual(["E-TASK-EDIT"]);
  });
});

describe("Task ids are path components (ENG-741)", () => {
  test("plan refuses an id dispatch could not use, naming it", () => {
    const decision = decideConstellation(
      planned([task(B)]),
      C.Plan.make({
        constellationId: CID,
        operations: [PlanOperation.cases.Add.make({ task: task(TaskId.make("P1.1")) })],
      }),
      ctx()
    );

    expect(decision.rejection?.findings).toEqual([
      expect.objectContaining({
        code: "E-TASK-ID",
        message: "Task id P1.1 may contain only letters, digits, - and _",
        fix: "Declare P1.1 with an id such as P1-1.",
      }),
    ]);
  });

  test("accepting a proposal with such an id is refused", () => {
    const record = apply(
      dispatched(planned([task(A)])),
      C.WorkerPropose.make({
        constellationId: CID,
        attemptId: draft().id,
        task: task(TaskId.make("A.2")),
      }),
      ctx({ binding: { kind: "session", sessionId: draft().sessionId } })
    );

    const decision = decideConstellation(
      record,
      C.Answer.make({
        constellationId: CID,
        action: AnswerAction.cases.Proposal.make({
          proposalId: [...record.proposals.keys()][0]!,
          accept: true,
          reason: "",
        }),
      }),
      ctx()
    );

    expect(decision.rejection?.findings.map((f) => f.code)).toEqual(["E-TASK-ID"]);
  });
});
