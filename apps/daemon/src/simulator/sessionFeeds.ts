/**
 * Each Agent Session's Simulator: the one it shows, and its agents' activity on it, as
 * `simulator.sessionFeed` items. Held in memory: a Daemon restart shows none until set again.
 */
import { type SimulatorSessionItem, SimulatorSessionItem as Item } from "@polaris/protocol";

type Listener = (item: SimulatorSessionItem) => void;

interface SessionSimulator {
  shown: string | null;
  driving: number;
  readonly listeners: Set<Listener>;
}

export class SessionFeeds {
  private readonly sessions = new Map<string, SessionSimulator>();

  shown(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.shown ?? null;
  }

  /** Makes `id` the session's Simulator: a `Showing` when it changed. */
  show(sessionId: string, id: string | null): void {
    const session = this.entry(sessionId);

    if (session.shown === id) return;
    session.shown = id;
    this.publish(session, Item.cases.Showing.make({ id }));
  }

  agentOpened(sessionId: string, id: string): void {
    const session = this.entry(sessionId);
    this.show(sessionId, id);
    this.publish(session, Item.cases.AgentOpened.make({ id }));
  }

  /** Counts overlapping holders: only the first and the last publish. */
  driving(sessionId: string): () => void {
    const session = this.entry(sessionId);
    session.driving += 1;

    if (session.driving === 1)
      this.publish(session, Item.cases.AgentDriving.make({ active: true }));
    let released = false;

    return () => {
      if (released) return;
      released = true;
      session.driving -= 1;

      if (session.driving === 0)
        this.publish(session, Item.cases.AgentDriving.make({ active: false }));
      this.prune(sessionId, session);
    };
  }

  /** Sends `Showing` first, and `AgentDriving` when an agent drives now, then every change. */
  subscribe(sessionId: string, listener: Listener): () => void {
    const session = this.entry(sessionId);
    listener(Item.cases.Showing.make({ id: session.shown }));

    if (session.driving > 0) listener(Item.cases.AgentDriving.make({ active: true }));
    session.listeners.add(listener);

    return () => {
      session.listeners.delete(listener);
      this.prune(sessionId, session);
    };
  }

  private entry(sessionId: string): SessionSimulator {
    let session = this.sessions.get(sessionId);

    if (session === undefined) {
      session = { shown: null, driving: 0, listeners: new Set() };
      this.sessions.set(sessionId, session);
    }

    return session;
  }

  private publish(session: SessionSimulator, item: SimulatorSessionItem): void {
    for (const listener of session.listeners) listener(item);
  }

  private prune(sessionId: string, session: SessionSimulator): void {
    if (session.shown === null && session.driving === 0 && session.listeners.size === 0)
      this.sessions.delete(sessionId);
  }
}
