import { expect, test } from "bun:test";
import {
  ConstellationEvent,
  PlanOperation,
  Task,
  TaskId,
  WorkerPlacement,
} from "@polaris/protocol";
import { Struct } from "effect";
import fc from "fast-check";
import { decideConstellation } from "../engine/constellation.ts";
import {
  A,
  B,
  C,
  CID,
  LEAD,
  WS,
  ctx,
  draft,
  foldDecision,
  task,
} from "../engine/constellation.testing.ts";
import type { ConstellationRecord } from "../store/constellation.ts";
import {
  emptyReference,
  foldReference,
  latest,
  observeFold,
  observeReference,
  referenceDeps,
  referenceDone,
  type Reference,
} from "./constellation.reference.testing.ts";
import { pbtRuns, pbtSeed } from "./pbt.ts";

const X = TaskId.make("X");

const waits = (ref: Reference) =>
  new Map(
    [...ref.tasks.values()].map((t) => [
      t.id,
      referenceDone(ref, t.id)
        ? new Set<string>()
        : new Set(
            [
              ...referenceDeps(ref, t.id),
              ...(latest(ref, t.id)?.state === "blocked" ? latest(ref, t.id)!.blockedOn : []),
            ].filter((id) => !referenceDone(ref, id))
          ),
    ])
  );

const reaches = (graph: ReturnType<typeof waits>, from: string, target: string) => {
  const todo = [from];
  const visited = new Set<string>();

  while (todo.length > 0) {
    const id = todo.pop()!;

    if (id === target) return true;

    if (visited.has(id)) continue;
    visited.add(id);
    todo.push(...(graph.get(id) ?? []));
  }

  return false;
};

const scenario = (accepted: boolean, edits: Array<[TaskId, TaskId[]]>) => {
  const ref = emptyReference();
  let record: ConstellationRecord | undefined;

  const commit = (command: import("@polaris/protocol").ConstellationCommand, context = ctx()) => {
    const result = decideConstellation(record, command, context);
    expect(result.rejection).toBeNull();
    foldReference(ref, result.events);
    record = foldDecision(record, result.events);
  };

  commit(
    C.Plan.make({
      constellationId: CID,
      start: { name: "Legacy", workspaceId: WS, leadSessionId: LEAD },
      operations: [A, B, X].map((id) => PlanOperation.cases.Add.make({ task: task(id) })),
    })
  );
  const attempt = draft();
  commit(
    C.Dispatch.make({
      constellationId: CID,
      tasks: [
        {
          taskId: A,
          worker: WorkerPlacement.cases.Existing.make({ sessionId: attempt.sessionId }),
        },
      ],
    }),
    ctx({ attempts: [attempt] })
  );
  commit(
    C.WorkerBlock.make({ constellationId: CID, attemptId: attempt.id, on: [B], reason: "Wait" }),
    ctx({ binding: { kind: "session", sessionId: attempt.sessionId } })
  );
  const seed = record!;

  const oldCycle = ConstellationEvent.cases.TaskEdited.make({
    constellationId: CID,
    revision: seed.graph.revision + 1,
    task: Task.make(
      Struct.assign(
        seed.graph.tasks.find((t) => t.id === B)!,
        { deps: [A], revision: 1 }
      )
    ),
  });

  foldReference(ref, [oldCycle]);
  record = foldDecision(seed, [oldCycle]);

  if (accepted) {
    const feed = draft(B, "feed");

    const started = ConstellationEvent.cases.AttemptStarted.make({
      constellationId: CID,
      revision: record.graph.revision + 1,
      attempt: feed,
    });

    const finished = ConstellationEvent.cases.AttemptAccepted.make({
      constellationId: CID,
      revision: record.graph.revision + 2,
      attemptId: feed.id,
      attemptRevision: 1,
      mergedHead: "head",
      receipts: [],
      evidence: "asserted",
    });

    foldReference(ref, [started, finished]);
    record = foldDecision(record, [started, finished]);
  }

  for (const [id, deps] of edits) {
    const old = waits(ref);
    const next = { ...ref, tasks: new Map(ref.tasks) };
    const current = ref.tasks.get(id)!;
    next.tasks.set(id, { ...current, deps });
    const edges = waits(next);

    const allowed = [...edges].every(([from, outgoing]) =>
      [...outgoing].every((to) => old.get(from)?.has(to) || !reaches(edges, to, from))
    );

    const result = decideConstellation(
      record,
      C.Plan.make({
        constellationId: CID,
        operations: [
          PlanOperation.cases.Edit.make({
            taskId: id,
            revision: current.revision,
            task: task(id, deps),
          }),
        ],
      }),
      ctx()
    );

    expect(result.rejection === null).toBe(allowed);

    if (allowed) {
      foldReference(ref, result.events);
      record = foldDecision(record, result.events);
    } else expect(result.events).toEqual([]);
    expect(observeFold(record)).toEqual(observeReference(ref));
  }
};

test("model permits legacy-cycle repairs and ignores accepted waits while rejecting newly cyclic edges", () => {
  fc.assert(
    fc.property(
      fc.boolean(),
      fc.array(fc.tuple(fc.constantFrom(A, B, X), fc.subarray([A, B, X])), {
        minLength: 1,
        maxLength: 30,
      }),
      scenario
    ),
    { numRuns: pbtRuns(100), ...pbtSeed() }
  );
});
