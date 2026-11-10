/**
 * The user taking the pointer and keyboard back during headed input (ADR 0104). The Host's
 * idle clock counts our own synthetic input too, so input counts as the user's only when it
 * came after our last action finished.
 */

/** Input in this long before a headed action means the user is at the pointer or keyboard. */
export const USER_ACTIVE_MS = 1500;

/** How long after one of our actions the Host may still be delivering its input. */
export const SETTLE_MS = 300;

export const tookOver = (host: string) =>
  `The user took over the pointer and keyboard on ${host}, so this action didn't run. Wait for them: don't retry right away, and take a new screenshot before you act again.`;

export interface Takeover {
  /** One of our actions just finished: input up to now is ours. */
  readonly acted: () => void;
  /** `idleMs`: how long since the Host's last pointer or keyboard input, null when unknown. */
  readonly userActive: (idleMs: number | null) => boolean;
}

/** One per Host: any session's input resets the Host's idle clock. */
export const takeover = (now: () => number = Date.now): Takeover => {
  let oursUntil = Number.NEGATIVE_INFINITY;

  return {
    acted: () => void (oursUntil = now()),
    userActive: (idleMs) =>
      idleMs !== null && idleMs < USER_ACTIVE_MS && now() - idleMs > oursUntil + SETTLE_MS,
  };
};
