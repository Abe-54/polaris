import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AttemptId,
  ConstellationCommand,
  PlanOperation,
  ReviewAction,
  SessionId,
  SetConstellationStateAction,
  WorkerPlacement,
  TaskDefinition,
  TaskId,
  type DomainEvent,
} from "@polaris/protocol";
import fc from "fast-check";
import { decideConstellation } from "../engine/constellation.ts";
import {
  A,
  B,
  C,
  CID,
  HOST,
  LEAD,
  ctx,
  draft,
  foldDecision,
  planned,
  report,
  task,
} from "../engine/constellation.testing.ts";
import { type ConstellationContext } from "../engine/constellation.inputs.ts";
import { type ConstellationRecord } from "../store/constellation.ts";
import {
  emptyReference,
  foldReference,
  latest,
  observeFold,
  observeReference,
  referenceDone,
  referenceDeps,
  referenceState,
  type Reference,
} from "./constellation.reference.testing.ts";
import { taskData } from "../constellation/data.ts";
import { projectTasks } from "../constellation/projections.ts";
import { pbtRuns, pbtSeed } from "./pbt.ts";

interface Step {
  command: ConstellationCommand;
  context: ConstellationContext;
  allowed: boolean;
}

const X = TaskId.make("X");

const choices = [A, B, X];

const active = (state: string | undefined) =>
  state === "working" || state === "blocked" || state === "review";

const metadataStep = (ref: Reference, op: number): Step => {
  const attempt = latest(ref, choices[op % 3]!);
  const approve = Math.floor(op / 3) === 8;
  const authorized = op % 2 === 0;

  return {
    command: C.Review.make({
      constellationId: CID,
      attemptId: AttemptId.make(attempt?.id ?? "missing"),
      revision: attempt?.revision ?? 0,
      action: approve
        ? ReviewAction.cases.Approve.make({})
        : ReviewAction.cases.HandUp.make({ reason: "Choose" }),
    }),
    context: ctx({
      binding: (approve ? authorized : !authorized)
        ? { kind: "user" }
        : { kind: "session", sessionId: LEAD },
    }),
    allowed:
      (ref.state === "planning" || ref.state === "running" || ref.state === "paused") &&
      attempt?.state === "review" &&
      authorized,
  };
};

const dispatchStep = (ref: Reference, taskId: TaskId, index: number): Step => {
  const sessionId = SessionId.make(`worker-${taskId}`);

  return {
    command: C.Dispatch.make({
      constellationId: CID,
      tasks: [{ taskId, worker: WorkerPlacement.cases.Existing.make({ sessionId }) }],
    }),
    context: ctx({ attempts: [draft(taskId, `a-${index}`, sessionId)] }),
    allowed:
      (ref.state === "planning" || ref.state === "running") &&
      latest(ref, taskId) === undefined &&
      referenceDeps(ref, taskId).every((dep) => referenceDone(ref, dep)),
  };
};

const referenceClosure = (ref: Reference, id: string) => {
  const pending = [id];
  const seen = new Set<string>();

  while (pending.length > 0) {
    const next = pending.pop()!;

    if (seen.has(next) || ref.tasks.get(next)?.canceled || referenceDone(ref, next)) continue;
    seen.add(next);
    pending.push(
      ...referenceDeps(ref, next),
      ...[...ref.attempts.values()].flatMap((a) =>
        a.taskId === next && a.state === "blocked" ? a.blockedOn : []
      ),
      ...[...ref.tasks.values()].flatMap((t) => (t.parent === next && !t.canceled ? [t.id] : []))
    );
  }

  return seen;
};

const blockStep = (ref: Reference, op: number): Step => {
  const taskId = choices[op % 3]!;
  const other = taskId === A ? B : A;
  const attempt = latest(ref, taskId);

  return {
    command: C.WorkerBlock.make({
      constellationId: CID,
      attemptId: AttemptId.make(attempt?.id ?? "missing"),
      on: [other],
      reason: "Wait",
    }),
    context: ctx({ binding: { kind: "session", sessionId: SessionId.make(`worker-${taskId}`) } }),
    allowed:
      (ref.state === "planning" || ref.state === "running" || ref.state === "paused") &&
      attempt?.state === "working" &&
      !referenceDone(ref, other) &&
      !referenceClosure(ref, other).has(taskId),
  };
};

const parentEditStep = (ref: Reference, index: number, mutable: boolean): Step => {
  const parent = ref.tasks.get("P")!;

  return {
    command: C.Plan.make({
      constellationId: CID,
      operations: [
        PlanOperation.cases.Edit.make({
          taskId: TaskId.make("P"),
          revision: parent.revision,
          task: task(TaskId.make("P"), index % 2 === 0 ? [X] : []),
        }),
      ],
    }),
    context: ctx(),
    allowed:
      mutable &&
      (index % 2 !== 0 || !["P", "Q", A, B].some((id) => referenceClosure(ref, X).has(id))),
  };
};

const claimStep = (ref: Reference, taskId: TaskId, index: number): Step => {
  const attempt = latest(ref, taskId);
  const attemptId = AttemptId.make(attempt?.id ?? "missing");

  const workerContext = ctx({
    binding: { kind: "session", sessionId: SessionId.make(`worker-${taskId}`) },
  });

  const base = { constellationId: CID, attemptId };

  const mutable = ref.state === "planning" || ref.state === "running" || ref.state === "paused";

  return {
    command: C.WorkerClaim.make({
      ...base,
      claim: report(`polaris/${taskId}`, index % 2 === 0 ? "head" : "revised-head"),
    }),
    context: ctx({
      ...workerContext,
      claimProbe: {
        dirtyPaths: [],
        branch: `polaris/${taskId}`,
        head: index % 2 === 0 ? "head" : "revised-head",
      },
    }),
    allowed:
      mutable &&
      (attempt?.state === "working" ||
        (attempt?.state === "review" &&
          attempt.head !== (index % 2 === 0 ? "head" : "revised-head"))) &&
      // A head an earlier Attempt on this Task had sent back needs a disposition; these Claims carry none.
      ![...ref.attempts.values()].some(
        (a) =>
          a.taskId === taskId &&
          a.id !== attempt?.id &&
          a.state === "rejected" &&
          a.head === (index % 2 === 0 ? "head" : "revised-head")
      ),
  };
};

/** Accept as of the latest revision, the Claim's own revision, or just before the Claim. */
const acceptStep = (
  ref: Reference,
  attempt: ReturnType<typeof latest>,
  index: number,
  mutable: boolean
): Step => {
  const seen = index % 3;
  const claimRevision = attempt?.claimRevision ?? attempt?.revision ?? 0;
  const revisions = [attempt?.revision ?? 0, claimRevision, Math.max(0, claimRevision - 1)];

  return {
    command: C.Review.make({
      constellationId: CID,
      attemptId: AttemptId.make(attempt?.id ?? "missing"),
      revision: revisions[seen]!,
      action: ReviewAction.cases.Accept.make({ mergedHead: attempt?.head ?? "head", receipts: [] }),
    }),
    context: ctx(),
    allowed: mutable && attempt?.state === "review" && seen !== 2,
  };
};

const step = (ref: Reference, op: number, index: number): Step => {
  const taskId = choices[op % 3]!;
  const attempt = latest(ref, taskId);
  const attemptId = AttemptId.make(attempt?.id ?? "missing");
  const sessionId = SessionId.make(`worker-${taskId}`);
  const mutable = ref.state === "planning" || ref.state === "running" || ref.state === "paused";
  const action = Math.floor(op / 3);
  const base = { constellationId: CID, attemptId };
  const workerContext = ctx({ binding: { kind: "session", sessionId } });

  if (action === 0) return dispatchStep(ref, taskId, index);

  if (action === 1)
    return {
      command: C.WorkerProgress.make({ ...base, note: "progress" }),
      context: workerContext,
      allowed: mutable && active(attempt?.state),
    };

  if (action === 2) return claimStep(ref, taskId, index);

  if (action === 3) return acceptStep(ref, attempt, index, mutable);

  if (action === 4)
    return {
      command: C.Review.make({
        ...base,
        revision: attempt?.revision ?? 0,
        action: ReviewAction.cases.SendBack.make({
          reason: `  fix ${index}\nλ keep both tests.  `,
          worker: WorkerPlacement.cases.Existing.make({ sessionId }),
        }),
      }),
      context: ctx({ attempts: [draft(taskId, `retry-${index}`, sessionId)] }),
      allowed: mutable && (attempt?.state === "review" || attempt?.state === "blocked"),
    };

  if (action === 5)
    return {
      command: C.Review.make({
        ...base,
        revision: (attempt?.revision ?? 0) + 1,
        action: ReviewAction.cases.Stop.make({ reason: "stale command" }),
      }),
      context: ctx(),
      allowed: false,
    };

  if (action === 6)
    return {
      command: C.SetState.make({
        constellationId: CID,
        action: SetConstellationStateAction.cases.Pause.make({}),
      }),
      context: ctx(),
      allowed: ref.state === "running",
    };

  if (action === 10) return parentEditStep(ref, index, mutable);

  if (action >= 8) return action === 11 ? blockStep(ref, op) : metadataStep(ref, op);

  return {
    command: C.SetState.make({
      constellationId: CID,
      action: SetConstellationStateAction.cases.Resume.make({}),
    }),
    context: ctx(),
    allowed: ref.state === "planning" || ref.state === "paused",
  };
};

let traceIndex = 0;

const run = (operations: ReadonlyArray<number>) => {
  const start = C.Plan.make({
    constellationId: CID,
    start: {
      name: "model",
      workspaceId: planned().graph.workspaceId,
      leadSessionId: planned().graph.leadSessionId,
      settings: planned().graph.settings,
    },
    operations: [
      task(X),
      task(TaskId.make("P"), [X]),
      new TaskDefinition({ ...taskData(task(TaskId.make("Q"))), parent: TaskId.make("P") }),
      new TaskDefinition({ ...taskData(task(A)), parent: TaskId.make("Q") }),
      new TaskDefinition({ ...taskData(task(B)), parent: TaskId.make("P") }),
      task(TaskId.make("G"), [TaskId.make("P")], "gate"),
    ].map((t) => PlanOperation.cases.Add.make({ task: t })),
  });

  const first = decideConstellation(undefined, start, ctx());
  let record: ConstellationRecord = foldDecision(undefined, first.events);
  const ref = emptyReference();
  foldReference(ref, first.events);

  const batches: Array<{ hostId: string; events: ReadonlyArray<DomainEvent> }> = [
    { hostId: HOST, events: first.events },
  ];

  for (const [index, op] of operations.entries()) {
    const input = step(ref, op, index);
    const decision = decideConstellation(record, input.command, input.context);
    expect(
      decision.rejection === null,
      JSON.stringify({ op, findings: decision.rejection?.findings })
    ).toBe(input.allowed);

    if (!input.allowed) expect(decision.events).toEqual([]);
    else {
      record = foldDecision(record, decision.events);
      foldReference(ref, decision.events);

      if (decision.events.length > 0) batches.push({ hostId: HOST, events: decision.events });
    }

    expect(observeFold(record)).toEqual(observeReference(ref));

    for (const projection of projectTasks(record))
      expect(projection.state).toBe(referenceState(ref, projection.taskId));

    if (referenceDone(ref, "P")) expect(record.promoted.has(TaskId.make("G"))).toBe(true);
    const sessions = record.graph.attempts.filter((a) => active(a.state)).map((a) => a.sessionId);
    expect(new Set(sessions).size).toBe(sessions.length);
  }

  if (process.env.POLARIS_TRACE_DIR !== undefined) {
    mkdirSync(process.env.POLARIS_TRACE_DIR, { recursive: true });
    writeFileSync(
      join(process.env.POLARIS_TRACE_DIR, `constellation-${traceIndex++}.json`),
      JSON.stringify({ version: 1, ownerHostId: HOST, batches })
    );
  }
};

test("model sequences compare the real decider and fold with independent command guards and reference fold", () => {
  fc.assert(
    fc.property(fc.array(fc.integer({ min: 0, max: 35 }), { minLength: 20, maxLength: 100 }), run),
    { numRuns: pbtRuns(100), ...pbtSeed() }
  );
});

test("model parent dependency edits preserve active rollup and gate descendants until acceptance", () => {
  run([30, 30, 0, 6, 30, 9, 1, 2, 8, 11, 1, 7, 10]);
});

test("blocked SendBack is modeled and emitted in a complete committed trace", () => {
  run([30, 0, 33, 12]);
});

test("a blocked Attempt cannot be accepted without a Claim after a parent dependency edit", () => {
  run([0, 30, 2, 35, 0, 11]);
});

test("model rejects mutual blocks through sibling Attempts", () => {
  run([30, 30, 0, 1, 33, 34]);
});

test("model rejects a parent edit that closes a live block through inherited dependencies", () => {
  run([30, 30, 2, 0, 35, 6, 30]);
});

test("model ignores a blocked target's accepted wait edges during a parent edit", () => {
  run([0, 30, 2, 0, 35, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 9, 0, 0, 0, 30]);
});
