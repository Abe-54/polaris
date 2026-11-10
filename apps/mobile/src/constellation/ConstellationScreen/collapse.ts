/**
 * The constellation header folds to its top row once the lead's thread scrolls back, the way a
 * large title collapses, and opens again at the newest end (owner, 2026-11-09, ENG-574).
 */

/** Points scrolled back from the newest Turn before the header folds. */
export const COLLAPSE_PAST = 24;

/** Within this of the newest Turn the header opens again; the gap keeps a bounce from flickering. */
export const EXPAND_WITHIN = 4;

/** Whether the header is folded at `offset`, the inverted list's distance from its newest end. */
export const headerCollapsed = (was: boolean, offset: number): boolean =>
  was ? offset > EXPAND_WITHIN : offset > COLLAPSE_PAST;
