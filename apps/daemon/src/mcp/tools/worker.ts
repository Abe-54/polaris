import {
  ConstellationCommand,
  TaskId,
  type ConstellationResult,
  type ConstellationRejected,
} from "@polaris/protocol";
import { Clock, Effect, Schema } from "effect";
import type { McpBinding } from "../binding.ts";
import type { toolFactory, BoundTool } from "./shared.ts";

const C = ConstellationCommand.cases;

/** `waiting_on`: what the worker waits on and about how long; `waiting.ts` caps it at 60 minutes. */
const WaitingOnInput = Schema.Struct({
  what: Schema.NonEmptyString,
  minutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
});

export const workerTools = (
  bound: Extract<McpBinding, { _tag: "Worker" }>,
  define: ReturnType<typeof toolFactory>,
  submit: (
    command: ConstellationCommand
  ) => Effect.Effect<ConstellationResult, ConstellationRejected>,
  status: BoundTool
): ReadonlyArray<BoundTool> => [
  define(
    "block",
    "Pause this Attempt while waiting on other Tasks. It resumes when all on Tasks are accepted. Use on: [] to wait for the Lead; use ask for a decision or answer, and continue any unblocked work first.",
    Schema.Struct({ on: C.WorkerBlock.fields.on, reason: C.WorkerBlock.fields.reason }),
    (input) =>
      submit(
        C.WorkerBlock.make({
          ...input,
          constellationId: bound.constellationId,
          attemptId: bound.attemptId,
        })
      ),
    {
      mutates: true,
      summary: "Attempt blocked; the Lead will hear why.",
      next: "End this Turn. Acceptance or a Lead message resumes the Attempt.",
    }
  ),
  define(
    "progress",
    "Record a progress note and optional completed/total count in the UI.",
    Schema.Struct({
      note: C.WorkerProgress.fields.note,
      completed: C.WorkerProgress.fields.completed,
      total: C.WorkerProgress.fields.total,
    }),
    (input) =>
      submit(
        C.WorkerProgress.make({
          ...input,
          constellationId: bound.constellationId,
          attemptId: bound.attemptId,
        })
      ),
    {
      mutates: true,
      summary: "Progress recorded.",
      next: "Continue the assignment; report the next useful milestone.",
    }
  ),
  define(
    "waiting_on",
    "Say this Attempt is waiting on background work you started (a background command, a Monitor, a background subagent, a long hook) before you end your Turn, so Polaris doesn't nudge you or tell the Lead you stopped. Give what you wait on and about how many minutes it takes (at most 60). It clears when your next Turn starts or you claim; if no Turn starts by then, you are nudged. Don't use block for this.",
    WaitingOnInput,
    (input) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        submit(
          C.WorkerProgress.make({
            constellationId: bound.constellationId,
            attemptId: bound.attemptId,
            note: `Waiting on ${input.what}`,
            completed: null,
            total: null,
            waiting: {
              on: input.what,
              until: new Date(now + input.minutes * 60_000).toISOString(),
            },
          })
        )
      ),
    {
      mutates: true,
      summary: "Waiting recorded; Polaris won't nudge you while it holds.",
      next: "End this Turn. Your Harness wakes you when the work reports, or Polaris nudges you after the time you gave.",
    }
  ),
  define(
    "ask",
    "Ask the Lead or user a question. Only the user grants approvals.",
    Schema.Struct({ question: C.WorkerAsk.fields.question }),
    (input) =>
      submit(
        C.WorkerAsk.make({
          ...input,
          constellationId: bound.constellationId,
          attemptId: bound.attemptId,
        })
      ),
    {
      mutates: true,
      summary: "Question recorded.",
      next: "Continue unblocked work; the answer arrives through Polaris.",
    }
  ),
  define(
    "claim",
    "Submit branch, head, commits, check receipts, unfinished work, follow-ups, questions, Area exceptions, decisions and summary. In review, a clean changed branch head can be claimed again on the same Attempt; it supersedes the earlier Claim and requires fresh review. Identical still-open questions may be repeated with the same id, recipient, text and blocking value; answered or changed questions need a new id.",
    Schema.Struct({ claim: C.WorkerClaim.fields.claim }),
    (input) =>
      submit(
        C.WorkerClaim.make({
          ...input,
          constellationId: bound.constellationId,
          attemptId: bound.attemptId,
        })
      ),
    {
      mutates: true,
      summary: "Claim recorded for review.",
      next: "Await the Lead’s review; a send-back creates a new Attempt.",
    }
  ),
  define(
    "propose",
    "Propose a new Task for the Lead to accept or decline.",
    Schema.Struct({ task: C.WorkerPropose.fields.task }),
    (input) =>
      submit(
        C.WorkerPropose.make({
          ...input,
          constellationId: bound.constellationId,
          attemptId: bound.attemptId,
        })
      ),
    {
      mutates: true,
      summary: "Proposal recorded.",
      next: "Continue the assigned Task; the Lead will review the proposal.",
    }
  ),
  define(
    "message",
    "Message a peer in this Constellation by its short Task id.",
    Schema.Struct({ to: TaskId, text: Schema.NonEmptyString }),
    (input) =>
      submit(
        C.WorkerMessage.make({
          ...input,
          constellationId: bound.constellationId,
          attemptId: bound.attemptId,
        })
      ),
    {
      mutates: true,
      summary: "Peer message queued.",
      next: "Continue the assignment; the peer receives a Polaris message.",
    }
  ),
  status,
];
