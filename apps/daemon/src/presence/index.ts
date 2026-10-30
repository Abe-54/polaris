/**
 * Presence (ENG-495): which connections say the user is at their Desktop App. `present`
 * is a lease per connection; it ends on `away`, when it lapses, or when the connection
 * closes. The Host is present while any lease is live. A timer runs only while one is.
 */
import type { UserPresence } from "@polaris/protocol";
import { Context } from "effect";

/** How long a `present` report holds; the Desktop App renews it at half this. */
export const PRESENCE_LEASE_MS = 120_000;

export interface PresenceOptions {
  readonly leaseMs?: number;
}

export class HostPresence extends Context.Service<
  HostPresence,
  {
    /** Records a connection's report; answers how long it holds (0 for `away`). */
    readonly report: (connectionId: number, presence: UserPresence) => number;
    /** The connection closed: its presence ends at once. */
    readonly disconnect: (connectionId: number) => void;
    /** Whether any connection's lease is live. */
    readonly present: () => boolean;
    /**
     * When the connection last reported `present` (ms since epoch), lease live or lapsed; null
     * when it never did or has closed. Browser hosting picks the most recent (ADR 0092).
     */
    readonly lastPresentAt: (connectionId: number) => number | null;
    /** Told each change of `present`; returns its unsubscribe. */
    readonly watch: (listener: (present: boolean) => void) => () => void;
  }
>()("polaris/daemon/presence/HostPresence") {
  static make(options: PresenceOptions = {}): HostPresence["Service"] {
    const leaseMs = options.leaseMs ?? PRESENCE_LEASE_MS;
    const leases = new Map<number, number>();
    const lastPresent = new Map<number, number>();
    const listeners = new Set<(present: boolean) => void>();
    let present = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timerAt = Number.POSITIVE_INFINITY;

    const settle = () => {
      const now = Date.now();

      for (const [id, until] of leases) if (until <= now) leases.delete(id);
      const next = Math.min(...leases.values());

      if (timer !== null && (next < timerAt || leases.size === 0)) {
        clearTimeout(timer);
        timer = null;
      }

      if (timer === null && Number.isFinite(next)) {
        timerAt = next;
        timer = setTimeout(
          () => {
            timer = null;
            settle();
          },
          Math.max(0, next - now)
        );
      }

      if (present === leases.size > 0) return;
      present = leases.size > 0;

      for (const listener of listeners) listener(present);
    };

    const disconnect = (connectionId: number) => {
      lastPresent.delete(connectionId);

      if (leases.delete(connectionId)) settle();
    };

    return HostPresence.of({
      report: (connectionId, presence) => {
        if (presence === "away") {
          const at = lastPresent.get(connectionId);
          disconnect(connectionId);

          if (at !== undefined) lastPresent.set(connectionId, at);

          return 0;
        }

        const now = Date.now();
        lastPresent.set(connectionId, now);
        leases.set(connectionId, now + leaseMs);
        settle();

        return leaseMs;
      },
      disconnect,
      present: () => present,
      lastPresentAt: (connectionId) => lastPresent.get(connectionId) ?? null,
      watch: (listener) => {
        listeners.add(listener);

        return () => listeners.delete(listener);
      },
    });
  }
}
