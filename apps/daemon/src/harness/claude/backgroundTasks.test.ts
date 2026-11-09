import { expect, test } from "bun:test";
import type {
  SDKBackgroundTasksChangedMessage,
  SDKTaskNotificationMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeBackgroundTasks } from "./backgroundTasks.ts";

const level = (
  tasks: SDKBackgroundTasksChangedMessage["tasks"]
): SDKBackgroundTasksChangedMessage => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks,
  uuid: crypto.randomUUID(),
  session_id: "s",
});

const notification = (task_id: string): SDKTaskNotificationMessage => ({
  type: "system",
  subtype: "task_notification",
  task_id,
  status: "completed",
  output_file: "",
  summary: "done",
  uuid: crypto.randomUUID(),
  session_id: "s",
});

test("the level replaces membership, hides ambient watchers, and accepts Monitor as a command", () => {
  const tasks = new ClaudeBackgroundTasks();
  const agent = { task_id: "a", task_type: "local_agent", description: "Research" };
  const monitor = { task_id: "m", task_type: "local_monitor", description: "Wait for build" };
  const ambient = { task_id: "w", task_type: "local_watch", description: "Watcher", ambient: true };
  expect(tasks.onMessage(level([agent, monitor, ambient]))).toMatchObject([
    {
      tasks: [
        { id: "a", kind: "subagent" },
        { id: "m", kind: "command" },
      ],
    },
  ]);
  expect(tasks.onMessage(level([agent, monitor, ambient]))).toEqual([]);
  expect(tasks.onMessage(level([]))).toMatchObject([{ tasks: [] }]);
  tasks.onMessage(notification("m"));
  tasks.onMessage(notification("a"));
  tasks.onMessage(notification("a"));
  tasks.onMessage(notification("w"));
  expect(tasks.takeReports()).toEqual([
    { id: "a", kind: "subagent" },
    { id: "m", kind: "command" },
  ]);
  expect(tasks.takeReports()).toEqual([]);
});

test("a notification before the level drops membership still reports exactly once", () => {
  const tasks = new ClaudeBackgroundTasks();
  tasks.onMessage(level([{ task_id: "c", task_type: "local_bash", description: "Sleep" }]));
  expect(tasks.onMessage(notification("c"))).toEqual([]);
  expect(tasks.onMessage(level([]))).toMatchObject([{ tasks: [] }]);
  tasks.onMessage(notification("c"));
  expect(tasks.takeReports()).toEqual([{ id: "c", kind: "command" }]);
});

test("ambient level changes cannot be undone by a later task_started edge", () => {
  const tasks = new ClaudeBackgroundTasks();
  tasks.onMessage(
    level([{ task_id: "w", task_type: "local_bash", description: "Watch", ambient: true }])
  );
  expect(
    tasks.onMessage({
      type: "system",
      subtype: "task_started",
      task_id: "w",
      task_type: "local_bash",
      is_backgrounded: true,
      description: "Watch",
      uuid: crypto.randomUUID(),
      session_id: "s",
    })
  ).toEqual([]);
  tasks.onMessage(notification("w"));
  expect(tasks.takeReports()).toEqual([]);
});

test("empty reports share storage and removed membership is pruned before later notifications", () => {
  const tasks = new ClaudeBackgroundTasks();
  expect(tasks.takeReports()).toBe(tasks.takeReports());
  tasks.onMessage(level([{ task_id: "gone", task_type: "local_bash", description: "Build" }]));
  tasks.onMessage(level([]));
  expect(tasks.takeReports()).toEqual([{ id: "gone", kind: "command" }]);
  tasks.onMessage(notification("gone"));
  expect(tasks.takeReports()).toEqual([]);
});

test("without the level, a foreground command moved to the background joins the tasks", () => {
  const tasks = new ClaudeBackgroundTasks();
  const frame = { uuid: crypto.randomUUID(), session_id: "s" };

  const started = tasks.onMessage({
    type: "system",
    subtype: "task_started",
    task_id: "b1",
    tool_use_id: "tu1",
    task_type: "local_bash",
    is_backgrounded: false,
    description: "bun dev",
    ...frame,
  });

  const moved = (task_id: string) =>
    tasks.onMessage({
      type: "system",
      subtype: "task_updated",
      task_id,
      patch: { is_backgrounded: true },
      ...frame,
    });

  expect(started).toEqual([]);
  expect(moved("b9")).toEqual([]);
  expect(moved("b1")).toMatchObject([
    { tasks: [{ id: "b1", kind: "command", description: "bun dev" }] },
  ]);
});

test("a task leaving the level says its report is pending until the reports are taken", () => {
  const tasks = new ClaudeBackgroundTasks();
  const build = { task_id: "b", task_type: "local_bash", description: "Build" };
  const lint = { task_id: "l", task_type: "local_bash", description: "Lint" };
  expect(tasks.onMessage(level([build, lint]))).toMatchObject([{ reportsPending: false }]);
  expect(tasks.onMessage(level([lint]))).toMatchObject([{ reportsPending: true }]);
  tasks.takeReports();
  expect(tasks.onMessage(level([lint, build]))).toMatchObject([{ reportsPending: false }]);
});

test("without the level, a notification's report is pending on the change it makes", () => {
  const tasks = new ClaudeBackgroundTasks();
  tasks.onMessage({
    type: "system",
    subtype: "task_started",
    task_id: "c",
    task_type: "local_bash",
    is_backgrounded: true,
    description: "Sleep",
    uuid: crypto.randomUUID(),
    session_id: "s",
  });
  expect(tasks.onMessage(notification("c"))).toMatchObject([{ tasks: [], reportsPending: true }]);
});

const startedInBackground = (task_id: string, task_type = "local_agent") => ({
  type: "system" as const,
  subtype: "task_started" as const,
  task_id,
  task_type,
  is_backgrounded: true,
  description: "Research",
  uuid: crypto.randomUUID(),
  session_id: "s",
});

// The `task_updated` that ends a Subagent, as fixtures/subagent-turn.jsonl recorded it.
test("without the level, a task whose update ends it leaves the tasks", () => {
  const tasks = new ClaudeBackgroundTasks();
  tasks.onMessage(startedInBackground("a"));
  tasks.onMessage(startedInBackground("b"));

  const ended = tasks.onMessage({
    type: "system",
    subtype: "task_updated",
    task_id: "a",
    patch: { status: "completed", end_time: 1790828024047 },
    uuid: crypto.randomUUID(),
    session_id: "s",
  });

  expect(ended).toMatchObject([{ tasks: [{ id: "b" }], reportsPending: false }]);
  expect(tasks.onMessage(notification("a"))).toMatchObject([
    { tasks: [{ id: "b" }], reportsPending: true },
  ]);
  expect(tasks.takeReports()).toEqual([{ id: "a", kind: "subagent" }]);
});

test("without the level, an ending with no transcript still leaves the tasks, unreported", () => {
  const tasks = new ClaudeBackgroundTasks();
  tasks.onMessage(startedInBackground("a"));
  expect(tasks.onMessage({ ...notification("a"), skip_transcript: true })).toMatchObject([
    { tasks: [] },
  ]);
  expect(tasks.takeReports()).toEqual([]);
});
