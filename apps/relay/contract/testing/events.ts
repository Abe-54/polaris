/**
 * The relay's log lines (README: Logs), as the suite reads them from its stdout. They carry
 * counts and opaque connection IDs only: no payloads, relay addresses, keys or network addresses.
 */

export interface ConnectionEvent {
  readonly event: "relay.connection";
  /** Random per connection; meaningless outside this line. */
  readonly conn: string;
  readonly role: "host" | "device" | null;
  readonly authenticated: boolean;
  readonly durationMs: number;
  readonly framesIn: number;
  readonly bytesIn: number;
  readonly framesOut: number;
  readonly bytesOut: number;
  readonly controlIn: number;
  readonly unreachable: number;
  readonly dropped: number;
  /** Wakes the host asked for on this socket. */
  readonly wakes: number;
  readonly closeCode: number;
  /** Why the relay closed it, or "peer" when the other end did. */
  readonly endedBy: string;
}

export interface RefusedEvent {
  readonly event: "relay.refused";
  readonly reason: string;
}

export interface StartEvent {
  readonly event: "relay.start";
  readonly port: number;
}

/** One wake's outcome. Never the token, the payload or which host or device asked. */
export interface WakeEvent {
  readonly event: "relay.wake";
  readonly outcome: string;
  readonly durationMs: number;
}

/** One merged Live Activity push: its outcome, how many hosts it carried, and whether it alerted. */
export interface LiveEvent {
  readonly event: "relay.live";
  readonly outcome: string;
  readonly hosts: number;
  readonly alert: boolean;
}

export type WideEvent = ConnectionEvent | RefusedEvent | StartEvent | WakeEvent | LiveEvent;
