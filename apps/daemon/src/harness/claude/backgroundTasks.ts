import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { BackgroundTask, type BackgroundTaskRef } from "@polaris/protocol";
import { Effect } from "effect";
import { HarnessError, HarnessEvent } from "../HarnessDriver.ts";

type TaskMessage = Extract<
  SDKMessage,
  { subtype: "task_started" | "task_updated" | "task_notification" | "background_tasks_changed" }
>;

const failed = (message: string) => (cause: unknown) =>
  new HarnessError({ harness: "claude", message, cause });

/** `StopBackgroundTasks` and `BackgroundCommand` on a live query. */
export const backgroundControls = (q: Pick<Query, "stopTask" | "backgroundTasks">) => ({
  /** Claude Code reports each stopped task with a `stopped` task notification. */
  stopBackground: (taskIds: ReadonlyArray<string>) =>
    Effect.tryPromise({
      try: () => Promise.all(taskIds.map((id) => q.stopTask(id))),
      catch: failed("Could not stop Claude's background task"),
    }).pipe(Effect.asVoid, Effect.withSpan("ClaudeSession.stopBackground")),
  /** Ctrl-B in Claude Code's TUI: a command's id is its `tool_use` id; null moves every one. */
  backgroundCommand: (itemId: string | null) =>
    Effect.tryPromise({
      try: () => q.backgroundTasks(itemId ?? undefined),
      catch: failed("Could not move the command to the background"),
    }).pipe(Effect.withSpan("ClaudeSession.backgroundCommand")),
});

const NO_REPORTS: ReadonlyArray<BackgroundTaskRef> = [];

/** The level signal owns waiting; edge notifications identify the next model call's trigger. */
export class ClaudeBackgroundTasks {
  private live: ReadonlyArray<BackgroundTask> = [];
  private readonly known = new Map<string, BackgroundTaskRef>();
  private readonly reports = new Map<string, BackgroundTaskRef>();
  /** Without the level signal: foreground tasks, which `task_updated` may move to the background. */
  private readonly foreground = new Map<string, BackgroundTask>();
  private levelSeen = false;

  takeReports(): ReadonlyArray<BackgroundTaskRef> {
    if (this.reports.size === 0) return NO_REPORTS;
    const reports = [...this.reports.values()];
    this.reports.clear();

    return reports;
  }

  onMessage(message: TaskMessage): HarnessEvent[] {
    switch (message.subtype) {
      case "background_tasks_changed":
        return this.onLevel(message);
      case "task_started":
        return this.onStarted(message);
      case "task_updated":
        return this.onUpdated(message);
      case "task_notification":
        return this.onNotification(message);
    }
  }

  private onLevel(
    message: Extract<TaskMessage, { subtype: "background_tasks_changed" }>
  ): HarnessEvent[] {
    this.levelSeen = true;
    this.foreground.clear();

    const tasks = message.tasks
      .filter((t) => t.ambient !== true)
      .map(
        (t) =>
          new BackgroundTask({
            id: t.task_id,
            kind: t.task_type === "local_agent" ? "subagent" : "command",
            description: t.description,
          })
      );

    for (const task of message.tasks) if (task.ambient === true) this.known.delete(task.task_id);

    const liveIds = new Set(tasks.map((task) => task.id));

    for (const [id, task] of this.known) {
      if (liveIds.has(id)) continue;
      this.known.delete(id);
      this.reports.set(id, task);
    }

    for (const task of tasks) this.remember(task);

    return this.replace(tasks);
  }

  private onStarted(message: Extract<TaskMessage, { subtype: "task_started" }>): HarnessEvent[] {
    if (this.levelSeen || message.ambient === true || message.skip_transcript === true) return [];

    const task = new BackgroundTask({
      id: message.task_id,
      kind:
        message.task_type === "local_agent" || message.subagent_type !== undefined
          ? "subagent"
          : "command",
      description: message.description,
    });

    if (message.is_backgrounded !== true) {
      this.foreground.set(task.id, task);

      return [];
    }

    return this.backgrounded(task);
  }

  /** A foreground task moved to the background (Ctrl-B, `BackgroundCommand`). */
  private onUpdated(message: Extract<TaskMessage, { subtype: "task_updated" }>): HarnessEvent[] {
    const task = this.foreground.get(message.task_id);

    if (this.levelSeen || task === undefined || message.patch.is_backgrounded !== true) return [];
    this.foreground.delete(task.id);

    return this.backgrounded(task);
  }

  private backgrounded(task: BackgroundTask): HarnessEvent[] {
    this.remember(task);

    return this.live.some((t) => t.id === task.id) ? [] : this.replace([...this.live, task]);
  }

  private onNotification(
    message: Extract<TaskMessage, { subtype: "task_notification" }>
  ): HarnessEvent[] {
    this.foreground.delete(message.task_id);

    if (message.ambient === true || message.skip_transcript === true) {
      this.known.delete(message.task_id);

      return [];
    }

    const task = this.known.get(message.task_id);

    if (task === undefined) return [];
    this.known.delete(message.task_id);
    this.reports.set(task.id, task);

    return this.levelSeen ? [] : this.replace(this.live.filter((t) => t.id !== task.id));
  }

  private remember(task: BackgroundTask): void {
    this.known.set(task.id, { id: task.id, kind: task.kind });
  }

  private replace(tasks: ReadonlyArray<BackgroundTask>): HarnessEvent[] {
    if (
      tasks.length === this.live.length &&
      tasks.every(
        (t, i) =>
          t.id === this.live[i]!.id &&
          t.kind === this.live[i]!.kind &&
          t.description === this.live[i]!.description
      )
    )
      return [];
    this.live = tasks;

    return [HarnessEvent.BackgroundTasksChanged({ tasks, reportsPending: this.reports.size > 0 })];
  }
}
