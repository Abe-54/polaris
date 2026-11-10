import { type DomainEvent, type TurnId, TurnItem } from "@polaris/protocol";
import { Match } from "effect";
import { HarnessEvent } from "../HarnessDriver.ts";

export interface Activity {
  readonly itemId: string;
  readonly turnId: TurnId;
  readonly command: string;
  readonly startedAt: number;
}

export interface LivenessFacts {
  readonly activities: ReadonlyMap<string, Activity>;
  readonly lastOutputAt: number | null;
  readonly usedTokens: number | null;
  readonly windowTokens: number | null;
}

export const emptyLiveness = (): LivenessFacts => ({
  activities: new Map(),
  lastOutputAt: null,
  usedTokens: null,
  windowTokens: null,
});

const isActivity = TurnItem.isAnyOf(["CommandExecution", "ToolCall"]);

const changeItem = (
  facts: LivenessFacts,
  item: TurnItem,
  turnId: TurnId,
  at: number
): LivenessFacts => {
  if (!isActivity(item)) return { ...facts, lastOutputAt: at };
  const activities = new Map(facts.activities);

  if (item.status === "running")
    activities.set(item.id, {
      itemId: item.id,
      turnId,
      command: Match.value(item).pipe(
        Match.tag("CommandExecution", (i) => i.command),
        Match.tag("ToolCall", (i) => i.name),
        Match.exhaustive
      ),
      startedAt: activities.get(item.id)?.startedAt ?? at,
    });
  else activities.delete(item.id);

  return { ...facts, activities, lastOutputAt: at };
};

/** Fold observed facts only; a worker's progress note cannot supply liveness. */
export const observeLiveness = (
  facts: LivenessFacts,
  event: HarnessEvent,
  at: number
): LivenessFacts =>
  HarnessEvent.$match(event, {
    ItemUpdated: (e) =>
      e.subagentId === undefined ? changeItem(facts, e.item, e.turnId, at) : facts,
    ItemCompleted: (e) =>
      e.subagentId === undefined ? changeItem(facts, e.item, e.turnId, at) : facts,
    ItemDelta: (e) => (e.subagentId === undefined ? { ...facts, lastOutputAt: at } : facts),
    ContextUsed: (e) => ({ ...facts, usedTokens: e.usedTokens, windowTokens: e.windowTokens }),
    TurnEnded: (e) => ({
      ...facts,
      activities: new Map(
        [...facts.activities].filter(([, activity]) => activity.turnId !== e.turnId)
      ),
    }),
    Exited: () => ({ ...facts, activities: new Map() }),
    CursorAssigned: () => facts,
    TurnStarted: () => facts,
    BackgroundTasksChanged: () => facts,
    SubagentStarted: () => facts,
    SubagentEnded: () => facts,
    ApprovalRequested: () => facts,
    ApprovalWithdrawn: () => facts,
    TitleSuggested: () => facts,
    ReplySuggested: () => facts,
    WorktreeCreated: () => facts,
  });

/** Completed items and context reports survive restart; unfinished tool timing stays unknown. */
export const restoreLiveness = (
  facts: LivenessFacts,
  event: DomainEvent,
  at: number
): LivenessFacts =>
  Match.value(event).pipe(
    Match.tag("SessionContextUsed", (e) => ({
      ...facts,
      usedTokens: e.usage.usedTokens,
      windowTokens: e.usage.windowTokens,
    })),
    Match.tag("TurnItemCompleted", (e) =>
      e.subagentId === null ? { ...facts, lastOutputAt: at } : facts
    ),
    Match.orElse(() => facts)
  );

/** Evaluate when viewed; queued input comes from the owning Engine's delivery journal. */
export const projectLiveness = (
  facts: LivenessFacts,
  now: number,
  queuedInput: number,
  activeTurn?: boolean
) => {
  const current = [...facts.activities.values()].at(-1) ?? null;

  return {
    current:
      current === null ? null : { ...current, elapsedMs: Math.max(0, now - current.startedAt) },
    activeTurn,
    lastOutputAt: facts.lastOutputAt,
    contextPercent:
      facts.usedTokens === null || facts.windowTokens === null || facts.windowTokens <= 0
        ? null
        : Math.min(100, Math.max(0, Math.floor((facts.usedTokens / facts.windowTokens) * 100))),
    queuedInput,
  };
};
