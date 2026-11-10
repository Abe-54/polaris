import { ConstellationEvent, MessageTarget, NotificationItem, Task } from "@polaris/protocol";
import { Predicate } from "effect";
import type { GraphCommand } from "../engine/constellation.inputs.ts";
import { questionKey } from "../store/constellation.ts";
import { taskData } from "./data.ts";
import { GraphDecision } from "./decision.ts";
import { validateGraph, validateTaskId } from "./plan.ts";

export const message = (d: GraphDecision, command: GraphCommand<"Message">) => {
  if (
    command.authority !== undefined &&
    command.authority !== "conversation" &&
    d.ctx.binding.kind !== "user"
  )
    d.reject(
      "E-AUTHORITY",
      "Only the user may confer decision authority",
      "Send an ordinary conversation message."
    );
  const target = command.target;

  if (
    Predicate.isTagged(target, "Worker") &&
    !d.record.graph.attempts.some(
      (a) =>
        a.id === target.attemptId &&
        (a.state === "working" || a.state === "blocked" || a.state === "review")
    )
  )
    d.reject(
      "E-TARGET",
      "The message target is not an active Attempt",
      "Choose the latest active worker from status."
    );

  if (d.findings.length > 0) return;
  const fields = d.fields();
  const id = `${fields.constellationId}:${fields.revision}:message`;
  d.emit(
    ConstellationEvent.cases.OperatorMessageSent.make({
      ...fields,
      id,
      authority: command.authority ?? "conversation",
      target: command.target,
      text: command.text,
      questionId: null,
    })
  );

  if (d.ctx.binding.kind === "user")
    d.notify(NotificationItem.cases.OperatorMessage.make({ messageId: id, text: command.text }));
};

export const answer = (d: GraphDecision, command: GraphCommand<"Answer">) => {
  if (Predicate.isTagged(command.action, "Proposal")) {
    const proposal = d.record.proposals.get(command.action.proposalId);

    if (proposal === undefined) {
      d.reject(
        "E-PROPOSAL",
        "The proposal is unknown or already answered",
        "Read status for open proposals."
      );

      return;
    }

    if (!command.action.accept) {
      d.emit(
        ConstellationEvent.cases.ProposalDeclined.make({
          ...d.fields(),
          proposalId: command.action.proposalId,
          reason: command.action.reason,
        })
      );

      return;
    }

    const task = new Task({ ...taskData(proposal.task), revision: 0, canceled: false });

    validateTaskId(
      d,
      task.id,
      "Decline the proposal and propose a Task id of letters, digits, - and _."
    );

    if (d.record.graph.tasks.some((t) => t.id === task.id))
      d.reject(
        "E-TASK-EXISTS",
        `Task ${task.id} already exists`,
        "Decline the proposal and propose a fresh Task id."
      );
    validateGraph(d, [...d.record.graph.tasks, task]);

    if (d.findings.length === 0)
      d.emit(
        ConstellationEvent.cases.ProposalAccepted.make({
          ...d.fields(),
          proposalId: command.action.proposalId,
          task,
        })
      );

    return;
  }

  const { attemptId, questionId, text } = command.action;
  const question = d.record.questions.get(questionKey(attemptId, questionId));

  if (question === undefined || question.answer !== null) {
    d.reject(
      "E-QUESTION",
      "The question is unknown or already answered",
      "Read status for open questions."
    );

    return;
  }

  if (
    !d.record.graph.openQuestions.some(
      (q) => q.attemptId === attemptId && q.question.id === questionId
    )
  ) {
    d.reject(
      "E-QUESTION-CLOSED",
      `Question ${questionId} closed when Attempt ${attemptId} settled`,
      "Message the Task's current worker if the answer still matters."
    );

    return;
  }

  if (question.question.to === "user" && d.ctx.binding.kind !== "user") {
    d.reject(
      "E-AUTHORITY",
      "This question is addressed to the user",
      "Leave the question in Needs you for the user."
    );

    return;
  }

  const fields = d.fields();
  d.emit(
    ConstellationEvent.cases.OperatorMessageSent.make({
      ...fields,
      id: `${fields.constellationId}:${fields.revision}:answer`,
      authority: "conversation",
      target: MessageTarget.cases.Worker.make({ attemptId }),
      text,
      questionId,
    })
  );
  d.notify(NotificationItem.cases.QuestionAnswered.make({ attemptId, questionId, text }));
};
