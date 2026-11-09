import { expect, test } from "bun:test";
import {
  BackgroundTask,
  SessionId,
  Subagent,
  SubagentId,
  TurnId,
  TurnTrigger,
} from "@polaris/protocol";
import { turnWith } from "../../../store/fixtures.testing.ts";
import type { TurnView } from "../../../store/sessionModel.ts";
import {
  rowWaiting,
  triggerPhrase,
  waitingLine,
  waitingOn,
  waitingPhrase,
  waitingTasks,
} from "./background.ts";

const task = (id: string, kind: "subagent" | "command") =>
  new BackgroundTask({ id, kind, description: `task ${id}` });

const trigger = (...kinds: ReadonlyArray<"subagent" | "command">) =>
  TurnTrigger.cases.BackgroundTasksReported.make({
    tasks: kinds.map((kind, n) => ({ id: `t${n}`, kind })),
  });

test("waiting says what it waits on, one kind or both", () => {
  expect(waitingPhrase([task("a", "subagent"), task("b", "subagent")])).toBe(
    "Waiting on 2 subagents"
  );
  expect(waitingPhrase([task("a", "command")])).toBe("Waiting on a command");
  expect(waitingPhrase([task("a", "subagent"), task("b", "command")])).toBe(
    "Waiting on 1 subagent and 1 command"
  );
  expect(waitingPhrase([task("a", "subagent"), task("b", "command"), task("c", "command")])).toBe(
    "Waiting on 1 subagent and 2 commands"
  );
});

test("only an Idle session waits; Working and Needs You keep their own line", () => {
  const tasks = [task("a", "subagent")];

  expect(waitingOn({ state: "idle", backgroundTasks: tasks })).toEqual(tasks);
  expect(waitingOn({ state: "working", backgroundTasks: tasks })).toEqual([]);
  expect(waitingOn({ state: "needs-you", backgroundTasks: tasks })).toEqual([]);
  expect(waitingOn({ state: "idle", backgroundTasks: [] })).toEqual([]);
});

test("a self-started Turn names the reports that woke it", () => {
  expect(triggerPhrase(trigger("subagent", "subagent"))).toBe("2 subagents reported");
  expect(triggerPhrase(trigger("command"))).toBe("A command finished");
  expect(triggerPhrase(trigger("subagent", "command", "command"))).toBe(
    "A subagent reported and 2 commands finished"
  );
  expect(triggerPhrase(trigger())).toBe("Continued on its own");
});

const subagent = (id: string, status: "working" | "completed") => ({
  subagent: new Subagent({
    id: SubagentId.make(id),
    sessionId: SessionId.make("s1"),
    turnId: TurnId.make("t1"),
    parentItemId: `call-${id}`,
    title: `Research ${id}`,
    agent: "general-purpose",
    model: null,
    status,
    startedAt: "2026-10-01T00:00:00.000Z",
    endedAt: status === "working" ? null : "2026-10-01T00:00:12.000Z",
    report: null,
  }),
  items: [],
  live: new Map(),
});

const turns: ReadonlyArray<TurnView> = [
  {
    turn: turnWith({ id: TurnId.make("t1"), index: 0, status: "completed" }),
    items: [],
    live: new Map(),
    subagents: [subagent("a", "working"), subagent("b", "completed"), subagent("c", "completed")],
  },
];

test("a sidebar row counts an open session's running Subagents, not the Host's stale tasks", () => {
  // The Host still lists all three Subagents and a command; the roster knows two have ended.
  const session = {
    state: "idle" as const,
    backgroundTasks: [task("a", "subagent"), task("b", "subagent"), task("c", "subagent")].concat([
      task("x", "command"),
    ]),
  };

  const open = rowWaiting(session, turns, true);

  expect(waitingLine(open)).toBe("Waiting on 1 subagent and 1 command");
  expect(waitingTasks(open).map((t) => [t.id, t.kind, t.description])).toEqual([
    ["a", "subagent", "Research a"],
    ["x", "command", "task x"],
  ]);
  // A closed session (no feed) has only the Host's tasks to go on.
  expect(waitingLine(rowWaiting(session, undefined, true))).toBe(
    "Waiting on 3 subagents and 1 command"
  );
});
