/**
 * Stamps a driver's Turn items with when it first saw them (`TurnItem.startedAt`):
 * the item's first delta, progress or completion. Stamps strictly increase within
 * the session, so items that started in the same millisecond keep their order.
 */
import { TurnItem } from "@polaris/protocol";
import { HarnessEvent } from "./HarnessDriver.ts";

export class ItemClock {
  /** Items seen but not completed, by Turn, Subagent and id. */
  private readonly seen = new Map<string, string>();
  /** The latest completed items' stamps: a reply completed again with its stats keeps its own. */
  private readonly completed = new Map<string, string>();
  private last = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** The event with its item stamped; other events pass through. */
  stamp(event: HarnessEvent): HarnessEvent {
    return HarnessEvent.$match(event, {
      ItemDelta: (e) => {
        this.startOf(keyOf(e.turnId, e.subagentId, e.itemId), null);

        return e;
      },
      ItemUpdated: (e) =>
        HarnessEvent.ItemUpdated({ ...e, item: this.stamped(e.turnId, e.subagentId, e.item) }),
      ItemCompleted: (e) => {
        const key = keyOf(e.turnId, e.subagentId, e.item.id);
        const item = this.stamped(e.turnId, e.subagentId, e.item);
        this.seen.delete(key);
        this.remember(key, item.startedAt);

        return HarnessEvent.ItemCompleted({ ...e, item });
      },
      CursorAssigned: (e) => e,
      TurnStarted: (e) => e,
      BackgroundTasksChanged: (e) => e,
      SubagentStarted: (e) => e,
      SubagentEnded: (e) => e,
      ApprovalRequested: (e) => e,
      ApprovalWithdrawn: (e) => e,
      TurnEnded: (e) => e,
      TitleSuggested: (e) => e,
      ReplySuggested: (e) => e,
      ContextUsed: (e) => e,
      WorktreeCreated: (e) => e,
      Exited: (e) => e,
    });
  }

  private stamped(turnId: string, subagentId: string | undefined, item: TurnItem): TurnItem {
    // Thinking the Harness didn't time keeps no times, so its row never ticks from a guess.
    if (TurnItem.guards.Reasoning(item) && item.startedAt === null) return item;
    const startedAt = this.startOf(keyOf(turnId, subagentId, item.id), item.startedAt);

    return { ...item, startedAt };
  }

  /** The item's stamp: the one it was first given, else now (or the Harness's own time). */
  private startOf(key: string, own: string | null): string {
    const known = this.seen.get(key) ?? this.completed.get(key);

    if (known !== undefined) return known;
    const at = own === null ? this.now() : Date.parse(own);
    this.last = Math.max(Number.isNaN(at) ? this.now() : at, this.last + 1);
    const stamp = new Date(this.last).toISOString();
    this.seen.set(key, stamp);

    return stamp;
  }

  private remember(key: string, stamp: string | null): void {
    if (stamp === null) return;
    this.completed.delete(key);
    this.completed.set(key, stamp);
    const oldest = this.completed.keys().next();

    if (this.completed.size > RECENT_COMPLETIONS && oldest.done !== true)
      this.completed.delete(oldest.value);
  }
}

/** How many completed items keep their stamps: a model call's own items, with room to spare. */
const RECENT_COMPLETIONS = 64;

const keyOf = (turnId: string, subagentId: string | undefined, itemId: string) =>
  `${turnId}\u0000${subagentId ?? ""}\u0000${itemId}`;
