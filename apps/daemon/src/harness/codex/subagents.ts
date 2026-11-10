/**
 * Codex Subagents (ENG-204). A Codex agent spawned from a Polaris thread runs
 * in its own thread on the same app-server, and its notifications reach our
 * connection. Multi-agent v2 reports it on the parent thread as
 * `subAgentActivity` items (started, completed, interrupted); v1 as a
 * `collabAgentToolCall` `spawnAgent` with the new threads, and statuses in
 * `agentsStates`. Each such thread is a Subagent of the Polaris Turn that
 * spawned it, and its items are the Subagent's own.
 */
import { SubagentId, type TurnId } from "@polaris/protocol";
import { HarnessEvent } from "../HarnessDriver.ts";
import type * as P from "./protocol.ts";

const { SubagentEnded, SubagentStarted } = HarnessEvent;

type Ending = "completed" | "failed" | "interrupted";

/** How a v1 agent's last known status ends it; absent while it still runs. */
const ENDINGS = new Map<string, Ending>([
  ["completed", "completed"],
  ["errored", "failed"],
  ["interrupted", "interrupted"],
  ["shutdown", "interrupted"],
  ["notFound", "interrupted"],
]);

/** The agent's name: the last segment of its path (`/root/pong` → `pong`). */
export const agentName = (path: string): string =>
  path.split("/").findLast((p) => p !== "") ?? path;

const firstLine = (text: string | null): string | null => {
  const line = text?.trim().split("\n")[0]?.trim() ?? "";

  return line === "" ? null : line.slice(0, 80);
};

export interface SubagentScope {
  readonly turnId: TurnId;
  readonly subagentId: SubagentId;
}

/** Who asks a server request: a Subagent, or nobody named for the session's own thread. */
export interface Asker {
  readonly subagentId?: SubagentId;
}

/** Where a server request goes: its Polaris Turn, and the Subagent asking. */
export interface RequestScope extends Asker {
  readonly turnId: TurnId;
}

export class CodexSubagents {
  /** Every Subagent thread seen, with the Polaris Turn it belongs to. */
  private readonly known = new Map<string, TurnId>();
  private readonly open = new Set<string>();

  /** The Subagent a thread is, if it is one. */
  scopeOf(threadId: string): SubagentScope | undefined {
    const turnId = this.known.get(threadId);

    return turnId === undefined ? undefined : { turnId, subagentId: SubagentId.make(threadId) };
  }

  /** A request from a thread other than the session's is its Subagent's, reported or not yet. */
  asking(sessionThread: string, requestThread: string): Asker {
    return requestThread === sessionThread ? {} : { subagentId: SubagentId.make(requestThread) };
  }

  /** What an item on the Polaris thread says about Subagents: their start or end. */
  fromParentItem(turnId: TurnId, item: P.ThreadItem): HarnessEvent[] {
    if (item.type === "subAgentActivity" && "agentThreadId" in item) {
      if (item.kind === "started") {
        const name = agentName(item.agentPath);

        return this.start(turnId, item.agentThreadId, item.id, {
          title: name,
          agent: name,
          model: null,
        });
      }

      return item.kind === "interacted" ? [] : this.end(item.agentThreadId, item.kind);
    }

    if (item.type !== "collabAgentToolCall" || !("receiverThreadIds" in item)) return [];

    const spawned =
      item.tool === "spawnAgent"
        ? item.receiverThreadIds.flatMap((thread) =>
            this.start(turnId, thread, item.id, {
              title: firstLine(item.prompt) ?? "Subagent",
              agent: null,
              model: item.model,
            })
          )
        : [];

    const ended = Object.entries(item.agentsStates).flatMap(([thread, state]) => {
      const ending = state === undefined ? undefined : ENDINGS.get(state.status);

      return ending === undefined ? [] : this.end(thread, ending);
    });

    return [...spawned, ...ended];
  }

  /** `parentItemId`: the Turn's item that spawned it, where its card goes. */
  private start(
    turnId: TurnId,
    thread: string,
    parentItemId: string,
    about: { readonly title: string; readonly agent: string | null; readonly model: string | null }
  ): HarnessEvent[] {
    if (this.known.has(thread)) return [];
    this.known.set(thread, turnId);
    this.open.add(thread);

    return [
      SubagentStarted({
        turnId,
        subagentId: SubagentId.make(thread),
        parentItemId,
        ...about,
      }),
    ];
  }

  private end(thread: string, status: Ending): HarnessEvent[] {
    if (!this.open.delete(thread)) return [];

    return [SubagentEnded({ subagentId: SubagentId.make(thread), status })];
  }
}
