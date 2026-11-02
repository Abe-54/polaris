/** A worker's tools as rows (block, progress, ask, claim, propose), and message for either role. */
import type {
  AskInput,
  BlockInput,
  ClaimInput,
  MessageInput,
  ProgressInput,
  ProposeInput,
  WaitingOnInput,
} from "./inputs.ts";
import type { Built, FieldRow, Segment } from "./types.ts";
import { checkOf, clip, count, ids, quote, shortHead } from "./words.ts";

const textWell = (text: string | undefined): Built["well"] =>
  text === undefined || text.trim() === "" ? null : { kind: "fields", text, rows: [], checks: [] };

export const message = ({ to, text }: typeof MessageInput.Type): Built => {
  const all = to === "all";

  return {
    head: {
      verbs: all
        ? ["Messaging all workers", "Messaged all workers", "message all workers"]
        : ["Messaging", "Messaged", "message"],
      subject: all || to === undefined ? null : { text: to, mono: true },
      detail: text === undefined ? [] : [quote(text)],
      caption: null,
    },
    well: textWell(text),
    links: all || to === undefined ? [] : [{ label: `Open ${to}`, taskId: to }],
  };
};

export const block = ({ on = [], reason }: typeof BlockInput.Type): Built => {
  const detail = reason === undefined ? [] : [{ text: clip(reason) }];

  if (on.length === 0)
    return {
      head: {
        verbs: ["Waiting for the lead", "Waiting for the lead", "wait for the lead"],
        subject: null,
        detail,
        caption: "resumes on a lead message",
      },
      well: textWell(reason),
      links: [],
    };

  return {
    head: {
      verbs: ["Blocking on", "Blocked on", "block on"],
      subject: { text: ids(on), mono: true },
      detail,
      caption: `resumes when ${ids(on)} ${on.length === 1 ? "is" : "are"} accepted`,
    },
    well: textWell(reason),
    links: [],
  };
};

export const progress = ({ note, completed, total }: typeof ProgressInput.Type): Built => {
  const counted = completed != null && total != null ? [{ text: `${completed} of ${total}` }] : [];

  return {
    head: {
      verbs: ["Reporting progress", "Reported progress", "report progress"],
      subject: null,
      detail: [...counted, ...(note === undefined || note === "" ? [] : [{ text: clip(note) }])],
      caption: null,
    },
    well: null,
    links: [],
  };
};

/** `waiting_on` (ENG-742): "Waiting on pre-push hook", "for about 10m". */
export const waitingOn = ({ what, minutes }: typeof WaitingOnInput.Type): Built => ({
  head: {
    verbs: ["Waiting on", "Waiting on", "wait on"],
    subject:
      what === undefined
        ? { text: "background work", mono: false }
        : { text: clip(what), mono: false },
    detail: [],
    caption: minutes === undefined ? null : `for about ${minutes}m`,
  },
  well: null,
  links: [],
});

export const ask = ({ question }: typeof AskInput.Type): Built => {
  const user = question?.to === "user";
  const text = question?.text;

  return {
    head: {
      verbs: user
        ? ["Asking you", "Asked you", "ask you"]
        : ["Asking the lead", "Asked the lead", "ask the lead"],
      subject: null,
      detail: [
        ...(text === undefined ? [] : [{ text: clip(text) }]),
        ...(question?.blocking === true ? [{ text: "· blocking", tone: "faint" as const }] : []),
      ],
      caption: user ? "Answer in Needs You" : null,
    },
    well: textWell(text),
    links: [],
  };
};

type Claim = NonNullable<(typeof ClaimInput.Type)["claim"]>;

const listRow = (label: string, items: ReadonlyArray<string> | undefined): Array<FieldRow> =>
  (items ?? []).map((text, i) => ({ label: i === 0 ? label : "", value: [{ text }] }));

const claimRows = (claim: Claim): ReadonlyArray<FieldRow> => {
  const commits = claim.commits?.length ?? 0;

  const branch: Array<Segment> = [
    { text: claim.branch ?? "", mono: true },
    ...(commits > 0 ? [{ text: count(commits, "commit"), tone: "faint" as const }] : []),
  ];

  return [
    ...(claim.branch === undefined ? [] : [{ label: "Branch", value: branch }]),
    ...listRow("Not done", claim.notDone),
    ...(claim.outsideArea ?? []).map((exception, i) => ({
      label: i === 0 ? "Outside area" : "",
      value: [
        { text: exception.path ?? "", mono: true },
        { text: exception.reason ?? "", tone: "faint" as const },
      ],
    })),
    ...listRow(
      "Questions",
      claim.questions?.map((q) => `${q.text ?? ""} · to ${q.to === "user" ? "you" : "the lead"}`)
    ),
    ...listRow("Follow-ups", claim.followups),
    ...listRow("Decisions", claim.decisions),
  ];
};

export const claim = ({ claim: claimed }: typeof ClaimInput.Type): Built => {
  if (claimed === undefined)
    return {
      head: { verbs: ["Claiming", "Claimed", "claim"], subject: null, detail: [], caption: null },
      well: null,
      links: [],
    };
  const receipts = claimed.receipts ?? [];
  const notDone = claimed.notDone?.length ?? 0;

  return {
    head: {
      verbs: ["Claiming", "Claimed", "claim"],
      subject: claimed.head === undefined ? null : { text: shortHead(claimed.head), mono: true },
      detail: [
        {
          text: `· ${count(receipts.length, "check")} · ${notDone > 0 ? `${notDone} not done` : "all done"}`,
        },
      ],
      caption: null,
    },
    well: {
      kind: "fields",
      text: claimed.summary ?? null,
      rows: claimRows(claimed),
      checks: receipts.map(checkOf),
    },
    links: [],
  };
};

export const propose = ({ task }: typeof ProposeInput.Type): Built => {
  const deps = task?.deps ?? [];

  const rows: Array<FieldRow> = [
    {
      label: "Task",
      value: [
        { text: task?.kind ?? "task" },
        ...(deps.length > 0 ? [{ text: `after ${ids(deps)}`, mono: true }] : []),
      ],
    },
    ...(task?.area ?? []).map((path, i) => ({
      label: i === 0 ? "Area" : "",
      value: [{ text: path, mono: true }],
    })),
  ];

  return {
    head: {
      verbs: ["Proposing a Task", "Proposed a Task", "propose a Task"],
      subject: task?.title === undefined ? null : { text: task.title },
      detail: [],
      caption: null,
    },
    well: { kind: "fields", text: task?.brief ?? null, rows, checks: [] },
    links: [],
  };
};
