import { stopLeadGates } from "../constellation/handover/gates.ts";
import {
  Constellation,
  ConstellationCommand,
  ConstellationEvent,
  DomainEvent,
  NotificationItem,
  SetConstellationStateAction,
  type ConstellationState,
} from "@polaris/protocol";
import { Match, Predicate } from "effect";
import { createMachine, isUnhandled, transition, types } from "xstate";
import { claim, currentAttempt, dispatch, review } from "../constellation/attempts.ts";
import { blockAttempt } from "../constellation/blocked.ts";
import { finding, GraphDecision, refusal } from "../constellation/decision.ts";
import { answer, message } from "../constellation/messages.ts";
import { effectiveDeps } from "../constellation/parents.ts";
import { plan } from "../constellation/plan.ts";
import { accepted, activeAttempt, latestAttempt } from "../constellation/projections.ts";
import {
  foldConstellation,
  questionKey,
  type ConstellationRecord,
} from "../store/constellation.ts";
import type { ConstellationContext } from "./constellation.inputs.ts";

export const constellationMachine = createMachine({
  id: "constellation",
  schemas: {
    events: {
      Dispatch: types<Record<string, never>>(),
      Pause: types<Record<string, never>>(),
      Resume: types<Record<string, never>>(),
      Complete: types<Record<string, never>>(),
      Archive: types<Record<string, never>>(),
      Mutate: types<Record<string, never>>(),
      HandOver: types<Record<string, never>>(),
    },
  },
  initial: "planning",
  states: {
    planning: {
      on: {
        Dispatch: () => ({ target: "running" }),
        Resume: () => ({ target: "running" }),
        Mutate: () => ({}),
        HandOver: () => ({}),
      },
    },
    running: {
      on: {
        Dispatch: () => ({}),
        Pause: () => ({ target: "paused" }),
        Complete: () => ({ target: "completed" }),
        Mutate: () => ({}),
        HandOver: () => ({}),
      },
    },
    paused: {
      on: {
        Resume: () => ({ target: "running" }),
        Complete: () => ({ target: "completed" }),
        Mutate: () => ({}),
        HandOver: () => ({}),
      },
    },
    completed: { on: { Archive: () => ({ target: "archived" }) } },
    archived: {},
  },
});

export type LifecycleInput = Parameters<typeof constellationMachine.transition>[1];

export const constellationTransition = (
  state: ConstellationState,
  input: LifecycleInput
): ConstellationState | null => {
  const snapshot = constellationMachine.resolveState({ value: state });
  const result = transition(constellationMachine, snapshot, input);

  if (isUnhandled(snapshot, result)) return null;

  return result[0].value;
};

/** A closed Constellation's refusal names it and points its Lead at the next one. */
const refuseLifecycle = (d: GraphDecision, input: LifecycleInput) => {
  const { name, state } = d.record.graph;
  const start = "start a new Constellation with plan start { name, workspaceId }";

  if (state === "archived")
    d.reject(
      "E-ARCHIVED",
      `Constellation "${name}" is archived`,
      `Its tools are closed; ${start}. status still reads it.`
    );
  else if (state === "completed")
    d.reject(
      "E-COMPLETED",
      `Constellation "${name}" is completed`,
      `Archive it with set_state, or ${start}.`
    );
  else
    d.reject(
      "E-STATE",
      `Cannot ${input.type} a ${state} Constellation`,
      "Use a lifecycle action available in the current state."
    );
};

const lifecycle = (d: GraphDecision, input: LifecycleInput) => {
  const state = constellationTransition(d.record.graph.state, input);

  if (state === null) refuseLifecycle(d, input);
  else if (state !== d.record.graph.state)
    d.emit(ConstellationEvent.cases.ConstellationStateChanged.make({ ...d.fields(), state }));
};

const promote = (d: GraphDecision) => {
  for (const task of d.record.graph.tasks) {
    if (
      task.kind === "gate" &&
      !task.canceled &&
      !d.record.promoted.has(task.id) &&
      effectiveDeps(d.record.graph.tasks, task.id).every((id) => accepted(d.record.graph, id))
    )
      d.emit(
        ConstellationEvent.cases.GatePromoted.make({
          ...d.fields(),
          taskId: task.id,
          taskRevision: task.revision + 1,
        })
      );
  }
};

const progress = (
  d: GraphDecision,
  command: Extract<ConstellationCommand, { _tag: "WorkerProgress" }>,
  attempt: import("@polaris/protocol").Attempt
) => {
  if (command.completed !== null && command.total !== null && command.completed > command.total)
    d.reject("E-PROGRESS", "Completed work exceeds the total", "Provide completed ≤ total.");
  else
    d.emit(
      ConstellationEvent.cases.AttemptProgressed.make({
        ...d.fields(),
        attemptId: attempt.id,
        attemptRevision: attempt.revision + 1,
        note: command.note,
        completed: command.completed,
        total: command.total,
        waiting: command.waiting,
      })
    );
};

const worker = (
  d: GraphDecision,
  command: Extract<ConstellationCommand, { attemptId: string }>
) => {
  const attempt = currentAttempt(
    d,
    command.attemptId,
    undefined,
    Match.value(command).pipe(
      Match.tag("WorkerBlock", () => "E-BLOCK-STATE"),
      Match.tag("WorkerClaim", () => "E-CLAIM-STATE"),
      Match.orElse(() => "E-SETTLED")
    )
  );

  if (attempt === undefined) return;

  if (d.ctx.binding.kind !== "session" || d.ctx.binding.sessionId !== attempt.sessionId) {
    d.reject(
      "E-AUTHORITY",
      "The worker binding does not own this Attempt",
      "Use the worker's bound tools."
    );

    return;
  }

  if (Predicate.isTagged(command, "WorkerClaim")) {
    claim(d, command, attempt);

    return;
  }

  if (Predicate.isTagged(command, "WorkerBlock")) {
    blockAttempt(d, command, attempt);
  } else if (Predicate.isTagged(command, "WorkerAsk")) {
    if (d.record.questions.has(questionKey(attempt.id, command.question.id)))
      d.reject(
        "E-QUESTION-EXISTS",
        `Question ${command.question.id} already exists`,
        "Use a fresh question id."
      );
    else
      d.notify(
        NotificationItem.cases.Question.make({ attemptId: attempt.id, question: command.question })
      );
  } else if (Predicate.isTagged(command, "WorkerProgress")) {
    progress(d, command, attempt);
  } else if (Predicate.isTagged(command, "WorkerPropose")) {
    const fields = d.fields();
    const proposalId = `${fields.constellationId}:${fields.revision}:proposal`;
    d.emit(
      ConstellationEvent.cases.TaskProposed.make({
        ...fields,
        proposalId,
        by: attempt.id,
        task: command.task,
      })
    );
    d.notify(NotificationItem.cases.Proposal.make({ attemptId: attempt.id, proposalId }));
  } else if (Predicate.isTagged(command, "WorkerMessage")) {
    const to = latestAttempt(d.record.graph, command.to);

    if (to === undefined || !activeAttempt(to))
      d.reject(
        "E-TARGET",
        `Task ${command.to} has no active worker`,
        "Choose an active peer from status."
      );
    else
      d.emit(
        ConstellationEvent.cases.PeerMessage.make({
          ...d.fields(),
          from: attempt.id,
          to: to.id,
          text: command.text,
        })
      );
  }
};

const cancelHandover = (d: GraphDecision) => {
  if (d.findings.length === 0 && d.record.handoverRequest !== null)
    d.emit(
      ConstellationEvent.cases.LeadHandoverCancelled.make({
        ...d.fields(),
        requestId: d.record.handoverRequest.requestId,
        reason: "Constellation stopped",
      })
    );
};

const setState = (
  d: GraphDecision,
  command: Extract<ConstellationCommand, { _tag: "SetState" }>
) => {
  SetConstellationStateAction.match(command.action, {
    Pause: () => lifecycle(d, { type: "Pause" }),
    Resume: () => lifecycle(d, { type: "Resume" }),
    Complete: () => {
      lifecycle(d, { type: "Complete" });
      cancelHandover(d);
    },
    Archive: () => {
      lifecycle(d, { type: "Archive" });
      cancelHandover(d);
    },
    HandOver: ({ summary, interrupt, selection }) => {
      lifecycle(d, { type: "HandOver" });

      if (d.ctx.handoverDeferred === true) {
        const fields = d.fields();
        d.emit(
          ConstellationEvent.cases.LeadHandoverRequested.make({
            ...fields,
            requestId: `${fields.constellationId}:${fields.revision}:handover`,
            from: d.record.graph.leadSessionId,
            summary,
            interrupt,
            selection,
          })
        );

        return;
      }

      const to = d.ctx.newLeadSessionId;

      if (
        to === null ||
        to === d.record.graph.leadSessionId ||
        d.ctx.occupiedSessions.has(to) ||
        d.record.graph.attempts.some((a) => a.sessionId === to && activeAttempt(a))
      )
        d.reject(
          "E-LEAD",
          "Handover needs a fresh Lead session",
          "Prepare a fresh session in the same Workspace."
        );

      if (d.findings.length === 0 && to !== null) {
        stopLeadGates(d);
        d.emit(
          ConstellationEvent.cases.LeadChanged.make({
            ...d.fields(),
            from: d.record.graph.leadSessionId,
            to,
            summary,
          })
        );
      }
    },
  });
};

const initial = (command: ConstellationCommand, ctx: ConstellationContext) => {
  if (!Predicate.isTagged(command, "Plan") || command.start === undefined) return undefined;

  return foldConstellation(
    undefined,
    ConstellationEvent.cases.ConstellationStarted.make({
      constellationId: command.constellationId,
      revision: 0,
      constellation: new Constellation({
        id: command.constellationId,
        workspaceId: command.start.workspaceId,
        hostId: ctx.hostId,
        leadSessionId: command.start.leadSessionId,
        leadBranch: ctx.leadBranch,
        name: command.start.name,
        state: "planning",
        revision: 0,
        settings: command.start.settings ?? ctx.defaults,
        tasks: [],
        attempts: [],
        pendingNotifications: [],
        createdAt: ctx.now,
        updatedAt: ctx.now,
      }),
    }),
    ctx.now
  );
};

export interface ConstellationDecision {
  readonly events: ReadonlyArray<DomainEvent>;
  readonly rejection: ReturnType<typeof refusal> | null;
}

const existingStart = (
  d: GraphDecision,
  record: ConstellationRecord | undefined,
  command: ConstellationCommand
) => {
  if (record !== undefined && Predicate.isTagged(command, "Plan") && command.start !== undefined)
    d.reject("E-EXISTS", "The Constellation already exists", "Plan without start.");
};

/** One atomic decision over the latest fold. No side effects, clocks, timers or actors. */
export const decideConstellation = (
  record: ConstellationRecord | undefined,
  command: ConstellationCommand,
  ctx: ConstellationContext
): ConstellationDecision => {
  const started = record === undefined ? initial(command, ctx) : record;

  if (started === undefined)
    return {
      events: [],
      rejection: refusal(record, [
        finding("E-NOT-FOUND", "The Constellation does not exist", "Start it with plan."),
      ]),
    };
  const d = new GraphDecision(started, ctx);

  existingStart(d, record, command);

  if (started.graph.hostId !== ctx.hostId)
    d.reject(
      "E-OWNER",
      "Only the Lead's Host may commit this graph",
      "Relay the command to the owning Daemon."
    );

  if (command.constellationId !== started.graph.id)
    d.reject(
      "E-NOT-FOUND",
      "The command names a different Constellation",
      "Use the current Constellation id."
    );

  const isWorker =
    Predicate.isTagged(command, "WorkerBlock") ||
    Predicate.isTagged(command, "WorkerClaim") ||
    Predicate.isTagged(command, "WorkerAsk") ||
    Predicate.isTagged(command, "WorkerProgress") ||
    Predicate.isTagged(command, "WorkerPropose") ||
    Predicate.isTagged(command, "WorkerMessage");

  if (
    !isWorker &&
    ctx.binding.kind !== "user" &&
    ctx.binding.sessionId !== started.graph.leadSessionId
  )
    d.reject(
      "E-AUTHORITY",
      "This command requires the current Lead or user",
      "Use a Lead binding."
    );

  if (d.findings.length > 0) return { events: [], rejection: refusal(record, d.findings) };

  if (record === undefined)
    d.events.push(
      ConstellationEvent.cases.ConstellationStarted.make({
        constellationId: started.graph.id,
        revision: 0,
        constellation: started.graph,
      })
    );

  if (!Predicate.isTagged(command, "SetState"))
    lifecycle(d, { type: Predicate.isTagged(command, "Dispatch") ? "Dispatch" : "Mutate" });

  if (d.findings.length === 0)
    ConstellationCommand.match(command, {
      Plan: (c) => plan(d, c),
      Dispatch: (c) => dispatch(d, c),
      Review: (c) => review(d, c),
      Answer: (c) => answer(d, c),
      Message: (c) => message(d, c),
      SetState: (c) => setState(d, c),
      WorkerBlock: (c) => worker(d, c),
      WorkerClaim: (c) => worker(d, c),
      WorkerAsk: (c) => worker(d, c),
      WorkerProgress: (c) => worker(d, c),
      WorkerPropose: (c) => worker(d, c),
      WorkerMessage: (c) => worker(d, c),
    });

  if (d.findings.length > 0) return { events: [], rejection: refusal(record, d.findings) };
  promote(d);

  const resources = Predicate.isTagged(command, "Plan")
    ? command.resources.map((resource) => DomainEvent.cases.ResourceDeclared.make({ resource }))
    : [];

  return { events: [...d.events, ...resources], rejection: null };
};
