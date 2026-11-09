/** The Lead's tools as rows: plan, dispatch, review, answer, status, set_state, read_worker. */
import { Match, Predicate } from "effect";
import type {
  AnswerInput,
  DispatchInput,
  PlanInput,
  ReadWorkerInput,
  ReviewInput,
  SetStateInput,
} from "./inputs.ts";
import type { ToolResult } from "./result.ts";
import type { Built, Segment, TaskLine, TurnLine } from "./types.ts";
import {
  checkOf,
  clip,
  count,
  harnessName,
  ids,
  quote,
  shortHead,
  workerSegments,
} from "./words.ts";

const fields = (text: string | null): Built["well"] =>
  text === null || text === "" ? null : { kind: "fields", text, rows: [], checks: [] };

const open = (taskId: string | undefined) =>
  taskId === undefined ? [] : [{ label: `Open ${taskId}`, taskId }];

type Operation = NonNullable<(typeof PlanInput.Type)["operations"]>[number];

const CHANGE = new Map([
  ["Add", "added"],
  ["Edit", "edited"],
  ["Cancel", "canceled"],
]);

const taskOf = (op: Operation) => ("task" in op ? op.task : undefined);

const idOf = (op: Operation) => taskOf(op)?.id ?? ("taskId" in op ? op.taskId : undefined) ?? "";

const taskLine = (op: Operation): TaskLine => {
  const task = taskOf(op);
  const deps = task?.deps ?? [];
  const area = task?.area?.[0];

  const note: Array<Segment> = [
    ...(task?.kind === "gate" ? [{ text: "Gate" }] : []),
    ...(deps.length > 0 ? [{ text: `after ${ids(deps)}` }] : []),
    ...(area === undefined ? [] : [{ text: area, mono: true }]),
  ];

  return {
    id: idOf(op),
    title: task?.title ?? "",
    note,
    change: [{ text: CHANGE.get(op._tag) ?? op._tag.toLowerCase() }],
    struck: Predicate.isTagged(op, "Cancel"),
  };
};

const changed = (ops: ReadonlyArray<Operation>, tag: string) =>
  ops.flatMap((op) => (Predicate.isTagged(op, tag) ? [idOf(op)] : []));

export const plan = ({ start, operations = [] }: typeof PlanInput.Type): Built => {
  const n = count(operations.length, "Task");
  const gates = operations.filter((op) => taskOf(op)?.kind === "gate").length;
  const edited = changed(operations, "Edit");
  const canceled = changed(operations, "Cancel");

  const detail = [
    ...(start?.name === undefined ? [] : [`started ${start.name}`]),
    ...(gates > 0 ? [count(gates, "Gate")] : []),
    ...(edited.length > 0 ? [`edited ${ids(edited)}`] : []),
    ...(canceled.length > 0 ? [`canceled ${ids(canceled)}`] : []),
  ].join(" · ");

  return {
    head: {
      verbs: [`Planning ${n}`, `Planned ${n}`, `plan ${n}`],
      subject: null,
      detail: detail === "" ? [] : [{ text: detail }],
      caption: null,
    },
    well:
      operations.length === 0
        ? null
        : { kind: "tasks", heading: start?.name ?? null, rows: operations.map(taskLine) },
    links: [],
  };
};

export const dispatch = ({ tasks = [], defaultWorker }: typeof DispatchInput.Type): Built => {
  const [only] = tasks;

  if (tasks.length === 1 && only !== undefined)
    return {
      head: {
        verbs: ["Starting", "Started", "start"],
        subject: { text: only.taskId, mono: true },
        detail: workerSegments(only.worker),
        caption: null,
      },
      well: null,
      links: open(only.taskId),
    };

  const n = tasks.length === 0 ? "ready Tasks" : count(tasks.length, "Task");

  return {
    head: {
      verbs: [`Starting ${n}`, `Started ${n}`, `start ${n}`],
      subject: null,
      detail:
        tasks.length === 0
          ? workerSegments(defaultWorker)
          : [{ text: ids(tasks.map((t) => t.taskId)), mono: true }],
      caption: null,
    },
    well:
      tasks.length === 0
        ? null
        : {
            kind: "tasks",
            heading: null,
            rows: tasks.map((t) => ({
              id: t.taskId,
              title: "",
              note: [],
              change: workerSegments(t.worker ?? defaultWorker),
            })),
          },
    links: [],
  };
};

type ReviewAction = NonNullable<(typeof ReviewInput.Type)["action"]>;

const reasonOf = (reason: string | null | undefined) =>
  reason == null || reason === "" ? [] : [quote(reason)];

const reviewHead = (task: string, action: ReviewAction): Built["head"] => {
  const subject = { text: task, mono: true };

  return Match.value(action).pipe(
    Match.tagsExhaustive({
      Accept: (a): Built["head"] => ({
        verbs: ["Accepting", "Accepted", "accept"],
        subject,
        detail: [{ text: shortHead(a.mergedHead ?? ""), mono: true, tone: "faint" }],
        caption: null,
      }),
      SendBack: (a): Built["head"] => ({
        verbs: ["Sending back", "Sent back", "send back"],
        subject,
        detail: reasonOf(a.reason),
        caption: null,
      }),
      Stop: (a): Built["head"] => ({
        verbs: ["Stopping", "Stopped", "stop"],
        subject,
        detail: reasonOf(a.reason),
        caption: null,
      }),
      HandUp: (a): Built["head"] => ({
        verbs: ["Handing you", "Handed you", "hand you"],
        subject: { text: `${task}'s Claim` },
        detail: reasonOf(a.reason),
        caption: null,
      }),
      Approve: (): Built["head"] => ({
        verbs: ["Approving", "Approved", "approve"],
        subject,
        detail: [],
        caption: null,
      }),
    })
  );
};

const reviewWell = (action: ReviewAction): Built["well"] =>
  Match.value(action).pipe(
    Match.tag("Accept", (a): Built["well"] => ({
      kind: "fields",
      text: null,
      rows: [{ label: "Merged", value: [{ text: a.mergedHead ?? "", mono: true }] }],
      checks: (a.receipts ?? []).map(checkOf),
    })),
    Match.tag("SendBack", (a): Built["well"] => ({
      kind: "fields",
      text: a.reason ?? null,
      rows: [{ label: "To", value: workerSegments(a.worker) }],
      checks: [],
    })),
    Match.orElse(() => null)
  );

export const review = ({ task = "", action }: typeof ReviewInput.Type): Built => {
  if (action === undefined)
    return {
      head: {
        verbs: ["Reviewing", "Reviewed", "review"],
        subject: null,
        detail: [],
        caption: null,
      },
      well: null,
      links: [],
    };

  return { head: reviewHead(task, action), well: reviewWell(action), links: open(task) };
};

type AnswerAction = NonNullable<(typeof AnswerInput.Type)["action"]>;

const question = (action: Extract<AnswerAction, { _tag: "Question" }>): Built => ({
  head: {
    verbs: ["Answering", "Answered", "answer"],
    subject: action.task === undefined ? null : { text: action.task, mono: true },
    detail: action.text === undefined ? [] : [{ text: clip(action.text) }],
    caption: null,
  },
  well: fields(action.text ?? null),
  links: open(action.task),
});

const proposal = (action: Extract<AnswerAction, { _tag: "Proposal" }> | undefined): Built => {
  const reason = action?.reason ?? "";

  return {
    head: {
      verbs:
        action?.accept === false
          ? ["Declining a proposal", "Declined a proposal", "decline a proposal"]
          : ["Accepting a proposal", "Accepted a proposal", "accept a proposal"],
      subject: action?.proposalId === undefined ? null : { text: action.proposalId, mono: true },
      detail: reason === "" ? [] : [{ text: clip(reason) }],
      caption: null,
    },
    well: fields(reason),
    links: [],
  };
};

export const answer = ({ action }: typeof AnswerInput.Type): Built => {
  return action !== undefined && Predicate.isTagged(action, "Question")
    ? question(action)
    : proposal(action);
};

export const status = (): Built => ({
  head: {
    verbs: ["Checking the constellation", "Checked the constellation", "check the constellation"],
    subject: null,
    detail: [],
    caption: null,
  },
  well: null,
  links: [],
});

const STATE_VERBS = new Map<string, readonly [string, string, string]>([
  ["Pause", ["Pausing", "Paused", "pause"]],
  ["Resume", ["Resuming", "Resumed", "resume"]],
  ["Complete", ["Completing", "Completed", "complete"]],
  ["Archive", ["Archiving", "Archived", "archive"]],
]);

export const setState = ({ action }: typeof SetStateInput.Type): Built => {
  if (action !== undefined && Predicate.isTagged(action, "HandOver")) {
    const harness = action.selection?.harness;

    const who = [harness === undefined ? null : harnessName(harness), action.selection?.model]
      .filter((part) => part != null)
      .join(" · ");

    return {
      head: {
        verbs: ["Handing the lead over", "Handed the lead over", "hand the lead over"],
        subject: null,
        detail:
          who === "" ? [] : [harness === undefined ? { text: who } : { text: who, hue: harness }],
        caption: null,
      },
      well: fields(action.summary ?? null),
      links: [],
    };
  }

  const [pending, done, refused] = STATE_VERBS.get(action?._tag ?? "") ?? ["Setting", "Set", "set"];

  return {
    head: {
      verbs: [
        `${pending} the constellation`,
        `${done} the constellation`,
        `${refused} the constellation`,
      ],
      subject: null,
      detail: [],
      caption: null,
    },
    well: null,
    links: [],
  };
};

const TURN = /^## Turn (\d+) · (\w+)(?: · started (\S+))?/;

export const clock = (iso: string | undefined) => {
  const at = iso === undefined ? Number.NaN : Date.parse(iso);

  return Number.isNaN(at)
    ? null
    : new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

/** `read_worker`'s transcript as Turns: each one's state, its last reply and its commands. */
export const transcriptTurns = (lines: ReadonlyArray<string>): ReadonlyArray<TurnLine> => {
  const turns: Array<{ heading: string; reply: string | null; commands: Array<string> }> = [];

  for (const line of lines) {
    const turn = TURN.exec(line);
    const current = turns.at(-1);

    if (turn !== null) {
      const time = clock(turn[3]);

      turns.push({
        heading: [`Turn ${turn[1]}`, turn[2], time].filter((p) => p != null).join(" · "),
        reply: null,
        commands: [],
      });
    } else if (current !== undefined && line.startsWith("Assistant: "))
      current.reply = clip(line.slice(11), 240);
    else if (current !== undefined && line.startsWith("$ ")) current.commands.push(line);
  }

  return turns;
};

export const readWorker = (
  { task = "a worker", turns = 2, since }: typeof ReadWorkerInput.Type,
  result: ToolResult | null
): Built => {
  const which = since === undefined ? `last ${count(turns, "Turn")}` : `Turns from ${since}`;
  const parsed = result === null ? [] : transcriptTurns(result.body);

  return {
    head: {
      verbs: ["Reading", "Read", "read"],
      subject: { text: `${task}'s ${which}` },
      detail: [],
      caption: null,
    },
    well: parsed.length === 0 ? null : { kind: "turns", turns: parsed },
    links: open(task === "a worker" ? undefined : task),
  };
};
