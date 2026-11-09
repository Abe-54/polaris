/**
 * The Polaris tools' inputs as the rows read them (`apps/daemon/src/mcp/tools`), loosely: a
 * field the row doesn't need, or one an older Daemon left out, never hides the call.
 */
import { Option, Schema } from "effect";
import type { ToolCallItem } from "./types.ts";

const Str = Schema.String;

const opt = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema);

const List = <S extends Schema.Top>(schema: S) => opt(Schema.Array(schema));

export const Selection = Schema.Struct({ harness: opt(Str), model: opt(Str) });

export const Worker = Schema.Struct({
  host: opt(Str),
  selection: opt(Schema.NullOr(Selection)),
  session: opt(Str),
});

export const TaskDef = Schema.Struct({
  id: opt(Str),
  title: opt(Str),
  kind: opt(Str),
  deps: opt(Schema.NullOr(Schema.Array(Str))),
  area: opt(Schema.NullOr(Schema.Array(Str))),
  brief: opt(Schema.NullOr(Str)),
});

const Operation = Schema.TaggedUnion({
  Add: { task: opt(TaskDef) },
  Edit: { taskId: opt(Str), task: opt(TaskDef) },
  Cancel: { taskId: opt(Str) },
});

export const PlanInput = Schema.Struct({
  start: opt(Schema.Struct({ name: opt(Str) })),
  operations: List(Operation),
});

export const DispatchInput = Schema.Struct({
  tasks: List(Schema.Struct({ taskId: Str, worker: opt(Worker) })),
  defaultWorker: opt(Worker),
});

export const Receipt = Schema.TaggedUnion({
  Verified: { label: opt(Str) },
  Reported: { label: opt(Str), exitCode: opt(Schema.NullOr(Schema.Number)) },
});

export const ReviewInput = Schema.Struct({
  task: opt(Str),
  revision: opt(Schema.Number),
  action: opt(
    Schema.TaggedUnion({
      Approve: {},
      Accept: { mergedHead: opt(Str), receipts: List(Receipt) },
      SendBack: { reason: opt(Str), worker: opt(Worker) },
      Stop: { reason: opt(Str) },
      HandUp: { reason: opt(Schema.NullOr(Str)) },
    })
  ),
});

export const AnswerInput = Schema.Struct({
  action: opt(
    Schema.TaggedUnion({
      Question: { task: opt(Str), text: opt(Str) },
      Proposal: { proposalId: opt(Str), accept: opt(Schema.Boolean), reason: opt(Str) },
    })
  ),
});

export const MessageInput = Schema.Struct({ to: opt(Str), text: opt(Str) });

export const SetStateInput = Schema.Struct({
  action: opt(
    Schema.TaggedUnion({
      Pause: {},
      Resume: {},
      Complete: {},
      Archive: {},
      HandOver: { summary: opt(Str), selection: opt(Schema.NullOr(Selection)) },
    })
  ),
});

export const ReadWorkerInput = Schema.Struct({
  task: opt(Str),
  turns: opt(Schema.Number),
  since: opt(Schema.Number),
});

export const WaitInput = Schema.Struct({ task: opt(Str), timeoutSeconds: opt(Schema.Number) });

export const NotifyInput = Schema.Struct({ title: opt(Str), body: opt(Str) });

/** `request_secret`: the card's label; its reason stays in the raw call. */
export const RequestSecretInput = Schema.Struct({ label: opt(Str) });

export const BlockInput = Schema.Struct({ on: List(Str), reason: opt(Str) });

export const WaitingOnInput = Schema.Struct({ what: opt(Str), minutes: opt(Schema.Number) });

export const ProgressInput = Schema.Struct({
  note: opt(Str),
  completed: opt(Schema.NullOr(Schema.Number)),
  total: opt(Schema.NullOr(Schema.Number)),
});

export const Question = Schema.Struct({
  id: opt(Str),
  to: opt(Str),
  text: opt(Str),
  blocking: opt(Schema.Boolean),
});

export const AskInput = Schema.Struct({ question: opt(Question) });

export const ClaimInput = Schema.Struct({
  claim: opt(
    Schema.Struct({
      branch: opt(Str),
      head: opt(Str),
      commits: List(Str),
      receipts: List(Receipt),
      notDone: List(Str),
      followups: List(Str),
      questions: List(Question),
      outsideArea: List(Schema.Struct({ path: opt(Str), reason: opt(Str) })),
      decisions: List(Str),
      summary: opt(Str),
    })
  ),
});

export const ProposeInput = Schema.Struct({ task: opt(TaskDef) });

/** The call's input as `schema` reads it; empty when it doesn't, so the row still shows. */
export const decodeInput = <S extends Schema.Decoder<object>>(
  schema: S,
  item: ToolCallItem
): S["Type"] => Option.getOrElse(Schema.decodeUnknownOption(schema)(item.input), () => ({}));
