/** The Self-Trace scope (ENG-710): Polaris's own Spans, kept apart from every checkout. */
import type { Retention } from "../database.ts";

/** Not a path, so it can never collide with a canonical checkout. */
export const SELF_CHECKOUT = "polaris:self";

export const SELF_RETENTION: Retention = {
  maxBytes: 50 * 1024 * 1024,
  maxAgeMs: 86400_000,
};

/** Self-Traces always use their own budget; checkouts use the store's configured one. */
export const retentionFor = (
  checkout: string,
  checkouts: Retention,
  self: Retention = SELF_RETENTION
) => (checkout === SELF_CHECKOUT ? self : checkouts);
