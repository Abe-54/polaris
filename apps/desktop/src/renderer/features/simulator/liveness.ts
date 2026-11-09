/**
 * Whether input reaches the Simulator. Frames can't say: a still screen still sends ~4.5 deltas
 * a second (spike surprise 8). An iOS barrier (`0x11`) is answered (`0x91`) only once every
 * touch before it reached native HID, so an unanswered or failed one means input is stuck.
 */

export const LIVENESS = {
  /** A barrier unanswered this long is stuck (the spike saw answers within 3 ms). */
  answerWithinMs: 2000,
  /** With no input, a barrier goes out this often, so a wedge shows before the user taps. */
  heartbeatMs: 3000,
} as const;

export interface BarrierWatch {
  /** A barrier going out now; its request id. */
  readonly sent: (now: number) => number;
  /** An answer: a null id is the oldest outstanding (a barrier sent without a body). */
  readonly answered: (requestId: number | null, ok: boolean) => void;
  readonly stalled: (now: number) => boolean;
  /** Whether a heartbeat barrier is due. */
  readonly due: (now: number) => boolean;
}

export const barrierWatch = (): BarrierWatch => {
  const outstanding = new Map<number, number>();
  let nextId = 1;
  let lastSent = Number.NEGATIVE_INFINITY;
  /** The latest answer said a message before it failed. */
  let failed = false;

  return {
    sent: (now) => {
      const id = nextId++;

      outstanding.set(id, now);
      lastSent = now;

      return id;
    },
    answered: (requestId, ok) => {
      const id = requestId ?? outstanding.keys().next().value;

      if (id === undefined || !outstanding.has(id)) return;

      // Barriers are answered in order: an answer settles every one sent before it.
      for (const key of outstanding.keys()) if (key <= id) outstanding.delete(key);
      failed = !ok;
    },
    stalled: (now) => {
      if (failed) return true;

      for (const sentAt of outstanding.values())
        if (now - sentAt >= LIVENESS.answerWithinMs) return true;

      return false;
    },
    due: (now) => outstanding.size === 0 && now - lastSent >= LIVENESS.heartbeatMs,
  };
};

/** Android has no barrier: there a stream that stops for this long is stalled. */
export const ANDROID_SILENCE_MS = 5000;
