/** C8: 128 Tasks in nine groups and a parent tree, for the large layout and the frame budget. */
import {
  AttemptId,
  ConstellationNotification,
  ConstellationQuestion,
  NotificationItem,
  TaskId,
} from "@polaris/protocol";
import { startedRecord } from "../model/fold.ts";
import type { ConstellationRecord } from "../model/index.ts";
import { attempt, b1Claim, constellationOf, task } from "./graph.ts";

const UPDATER = "I · Updater";

/** A parent U two levels deep in its own group: U2 blocked by U1b, U3 on the Lead. */
const treeTasks = [
  task({ id: "U", title: "Update feed and updater", group: UPDATER }),
  task({ id: "U1", title: "Signed update feed", group: UPDATER, parent: "U" }),
  task({ id: "U1a", title: "Feed schema", group: UPDATER, parent: "U1" }),
  task({ id: "U1b", title: "Sign and serve the feed", group: UPDATER, parent: "U1" }),
  task({ id: "U2", title: "Updater polls the feed", group: UPDATER, parent: "U", ui: true }),
  task({ id: "U3", title: "Release notes in the updater", group: UPDATER, parent: "U", ui: true }),
];

const treeAttempts = [
  attempt({
    taskId: "U1a",
    state: "accepted",
    minutes: 90,
    mergedHead: "ab12cd3",
    evidence: "verified",
  }),
  attempt({ taskId: "U1b", state: "working", minutes: 21 }),
  attempt({
    taskId: "U2",
    state: "blocked",
    minutes: 18,
    blocked: { on: ["U1b"], reason: "Needs the signed feed URL to poll" },
  }),
  attempt({
    taskId: "U3",
    state: "blocked",
    minutes: 12,
    blocked: { on: [], reason: "Markdown or the site's MDX for the notes?" },
  }),
];

type Mix = Readonly<{
  done?: number;
  working?: number;
  review?: number;
  waiting?: number;
  ask?: number;
}>;

const GROUPS: ReadonlyArray<readonly [letter: string, name: string | null, mix: Mix]> = [
  ["A", "A · Events and store", { done: 14 }],
  ["B", "B · Engine decider", { working: 2, done: 16 }],
  ["C", "C · Tool surface", { ask: 1, review: 2, working: 3, waiting: 6 }],
  ["D", "D · Daemon transport", { review: 2, working: 2, done: 12, waiting: 6 }],
  ["E", "E · Desktop tab", { review: 2, working: 2, done: 4, waiting: 12 }],
  ["F", "F · Spec and model tests", { done: 16 }],
  ["H", "G · Bench and leases", { done: 5, waiting: 6 }],
  ["G", null, { done: 4, waiting: 3 }],
  ["X", null, { waiting: 8 }],
];

const TITLES = [
  "Token revocation on archive",
  "Review and answer tools",
  "Status as a readable outline",
  "Findings with stable codes",
  "Scripted eval on the bench harness",
  "Lead skill instructions",
  "Worker skill instructions",
  "Outbox relay",
  "Bundle transfer",
  "Resume across restarts",
];

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

type State = keyof Mix;

const ORDER: ReadonlyArray<State> = ["ask", "review", "working", "done", "waiting"];

const statesOf = (mix: Mix): ReadonlyArray<State> =>
  ORDER.flatMap((key) => Array.from({ length: mix[key] ?? 0 }, () => key));

const attemptFor = (id: string, state: State, n: number) => {
  if (state === "done")
    return attempt({
      taskId: id,
      state: "accepted",
      minutes: 200 - n,
      mergedHead: "abc1234",
      evidence: "verified",
    });

  if (state === "working" || state === "ask")
    return attempt({ taskId: id, state: "working", minutes: 3 + n * 3 });

  return state === "review"
    ? attempt({ taskId: id, state: "review", minutes: 30, claim: b1Claim })
    : null;
};

const askFor = (id: string) =>
  new ConstellationNotification({
    id: `n-${id}`,
    item: NotificationItem.cases.Question.make({
      attemptId: AttemptId.make(`att-${id}-1`),
      question: new ConstellationQuestion({
        id: `q-${id}`,
        to: "user",
        text: "Revoke on archive or on Attempt end?",
        blocking: true,
      }),
    }),
    queuedAt: ago(4),
  });

const titleOf = (letter: string, n: number) =>
  letter === "G"
    ? `${TITLES[n % TITLES.length]} merged`
    : (TITLES[(n + letter.charCodeAt(0)) % TITLES.length] ?? `${letter}${n}`);

/** Waiting Tasks wait across groups; the rest run in chains of three, each after the one before. */
const depsOf = (letter: string, state: string, n: number) => {
  if (state === "waiting") return [`A${(n % 14) + 1}`, "C1"];

  return letter !== "G" && n % 3 !== 1 ? [`${letter}${n - 1}`] : [];
};

export const largeRecord = (): ConstellationRecord => {
  const cells = GROUPS.flatMap(([letter, group, mix]) =>
    statesOf(mix).map((state, index) => ({ letter, group, state, n: index + 1 }))
  );

  const grid = cells.map(({ letter, group, state, n }) =>
    task({
      id: `${letter}${n}`,
      title: titleOf(letter, n),
      group,
      kind: letter === "G" ? "gate" : "task",
      deps: depsOf(letter, state, n),
      ui: letter === "E" || n % 5 === 0,
    })
  );

  const tasks = [...grid, ...treeTasks];

  const attempts = [
    ...cells.flatMap(({ letter, state, n }) => {
      const a = attemptFor(`${letter}${n}`, state, n);

      return a === null ? [] : [a];
    }),
    ...treeAttempts,
  ];

  const notifications = cells.flatMap(({ letter, state, n }) =>
    state === "ask" ? [askFor(`${letter}${n}`)] : []
  );

  const base = startedRecord(
    constellationOf({ tasks, attempts, pendingNotifications: notifications }),
    400
  );

  return {
    ...base,
    proposals: [
      {
        proposalId: "p-1",
        by: AttemptId.make("att-C3-1"),
        task: {
          id: TaskId.make("X9"),
          title: "Lease bench and smoke",
          kind: "task",
          deps: [],
          area: [],
          brief: "",
          criteria: [],
          suggested: null,
          group: null,
          parent: null,
        },
        at: ago(2),
      },
      {
        proposalId: "p-2",
        by: AttemptId.make("att-D2-1"),
        task: {
          id: TaskId.make("X10"),
          title: "Relay retries with backoff",
          kind: "task",
          deps: [],
          area: [],
          brief: "",
          criteria: [],
          suggested: null,
          group: null,
          parent: null,
        },
        at: ago(5),
      },
    ],
  };
};
