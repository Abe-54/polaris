import {
  AnswerAction,
  ConstellationCommand,
  MessageTarget,
  ReviewAction,
  SetConstellationStateAction,
  TaskId,
  type ConstellationResult,
  type ConstellationRejected,
} from "@polaris/protocol";
import { Effect, Schema } from "effect";
import type { McpBinding } from "../binding.ts";
import type { toolFactory, BoundTool, StartTarget } from "./shared.ts";
import type { resolvers } from "./resolve.ts";
import { FriendlyWorker, FriendlyReview, FriendlyAnswer } from "./inputs.ts";

const C = ConstellationCommand.cases;

const R = ReviewAction.cases;

const A = AnswerAction.cases;

export const leadTools = (
  binding: McpBinding,
  define: ReturnType<typeof toolFactory>,
  submit: (
    command: ConstellationCommand
  ) => Effect.Effect<ConstellationResult, ConstellationRejected>,
  resolve: ReturnType<typeof resolvers>,
  status: BoundTool,
  start: StartTarget
): ReadonlyArray<BoundTool> => [
  define(
    "plan",
    "Start a Constellation with start { name, workspaceId }, then batch add, edit or cancel Tasks with short ids. Edit and cancel require the current Task revision. Edit changes only the fields you give; pass null or [] to clear one. Nest related Tasks with parent (for example F1–F3 under fix round F), to any depth; use group for the broad area. Parents are containers: dispatch their children and keep Gates separate.",
    Schema.Struct({
      start: Schema.optionalKey(
        Schema.Struct({
          name: Schema.NonEmptyString,
          workspaceId: C.Plan.fields.start.schema.fields.workspaceId,
          settings: C.Plan.fields.start.schema.fields.settings,
        })
      ),
      operations: C.Plan.fields.operations,
      resources: C.Plan.fields.resources,
    }),
    (input) => {
      const fields = {
        operations: input.operations,
        resources: input.resources,
        constellationId: binding.constellationId,
      };

      if (input.start === undefined) return submit(C.Plan.make(fields));

      return submit(
        C.Plan.make({
          ...fields,
          constellationId: start.constellationId,
          start: { ...input.start, leadSessionId: binding.sessionId },
        })
      ).pipe(Effect.tap(() => start.started));
    },
    { summary: "Plan recorded.", mutates: true }
  ),
  define(
    "dispatch",
    "Dispatch named Tasks, or all ready Tasks with defaultWorker. Use {host, selection?} for new workers or {session} for existing workers.",
    Schema.Struct({
      tasks: Schema.optionalKey(
        Schema.Array(Schema.Struct({ taskId: TaskId, worker: FriendlyWorker }))
      ),
      defaultWorker: Schema.optionalKey(FriendlyWorker),
    }),
    Effect.fnUntraced(function* (input) {
      const tasks = yield* Effect.forEach(
        input.tasks ?? [],
        Effect.fnUntraced(function* (task) {
          return { taskId: task.taskId, worker: yield* resolve.worker(task.worker) };
        })
      );

      const defaultWorker =
        input.defaultWorker === undefined ? null : yield* resolve.worker(input.defaultWorker);

      return yield* submit(
        C.Dispatch.make({ constellationId: binding.constellationId, tasks, defaultWorker })
      );
    }),
    { summary: "Dispatch recorded.", mutates: true }
  ),
  define(
    "review",
    "Accept the exact claimed head (Polaris merges it into your branch, refusing on conflicts or a dirty checkout) with receipts, send back with a reason and worker placement, stop, or hand a Claim to the user. Requires the Attempt revision from status; only the user grants approval.",
    Schema.Struct({
      task: Schema.NonEmptyString,
      revision: C.Review.fields.revision,
      action: FriendlyReview,
    }),
    Effect.fnUntraced(function* (input) {
      const action = yield* FriendlyReview.match(input.action, {
        Accept: (value): Effect.Effect<ReviewAction, ConstellationRejected> =>
          Effect.succeed(R.Accept.make(value)),
        Stop: (value) => Effect.succeed(R.Stop.make(value)),
        HandUp: (value) => Effect.succeed(R.HandUp.make(value)),
        SendBack: Effect.fnUntraced(function* (value) {
          return R.SendBack.make({ ...value, worker: yield* resolve.worker(value.worker) });
        }),
      });

      return yield* submit(
        C.Review.make({
          constellationId: binding.constellationId,
          attemptId: yield* resolve.attempt(input.task),
          revision: input.revision,
          action,
        })
      );
    }),
    { summary: "Review recorded.", mutates: true }
  ),
  define(
    "answer",
    "Answer a worker question using its short Task id or worker name and questionId, or accept or decline a proposal by proposalId. User questions and approvals stay with the user.",
    Schema.Struct({ action: FriendlyAnswer }),
    Effect.fnUntraced(function* (input) {
      const action = yield* FriendlyAnswer.match(input.action, {
        Proposal: (value): Effect.Effect<AnswerAction, ConstellationRejected> =>
          Effect.succeed(A.Proposal.make(value)),
        Question: Effect.fnUntraced(function* (value) {
          return A.Question.make({
            attemptId: yield* resolve.attempt(value.task),
            questionId: value.questionId,
            text: value.text,
          });
        }),
      });

      return yield* submit(C.Answer.make({ constellationId: binding.constellationId, action }));
    }),
    { summary: "Answer recorded.", mutates: true }
  ),
  define(
    "message",
    "Steer one worker by short Task id or worker session name, or send a note to all workers with to: all.",
    Schema.Struct({ to: Schema.NonEmptyString, text: Schema.NonEmptyString }),
    Effect.fnUntraced(function* (input) {
      const target =
        input.to === "all"
          ? MessageTarget.cases.All.make({})
          : MessageTarget.cases.Worker.make({ attemptId: yield* resolve.attempt(input.to) });

      return yield* submit(
        C.Message.make({ constellationId: binding.constellationId, target, text: input.text })
      );
    }),
    { summary: "Message queued.", mutates: true }
  ),
  status,
  define(
    "set_state",
    "Pause, resume, complete, archive or hand over the Constellation. HandOver accepts Harness and model names in selection.",
    Schema.Struct({ action: C.SetState.fields.action }),
    Effect.fnUntraced(function* (input) {
      const action = yield* SetConstellationStateAction.match(input.action, {
        Pause: (value): Effect.Effect<SetConstellationStateAction, ConstellationRejected> =>
          Effect.succeed(value),
        Resume: (value) => Effect.succeed(value),
        Complete: (value) => Effect.succeed(value),
        Archive: (value) => Effect.succeed(value),
        HandOver: Effect.fnUntraced(function* (value) {
          return SetConstellationStateAction.cases.HandOver.make({
            ...value,
            selection: yield* resolve.selection(value.selection),
          });
        }),
      });

      return yield* submit(C.SetState.make({ constellationId: binding.constellationId, action }));
    }),
    { summary: "Constellation state action recorded.", mutates: true }
  ),
];
