/**
 * Review's view (M2-D): a pull request or an Agent Session's Turns on Pierre Diffs, with
 * the queue, the file list and Viewed marks. Other slices plug into it through `surface.ts`:
 * the Risk Summary and comments (M2-F), the checkout chip (M2-K), accepting Turns (M2-A).
 */
export { preloadReview, reviewChunk, ReviewView } from "./ui/LazyReview.tsx";

export type { ReviewViewProps } from "./ui/ReviewView.tsx";

export {
  ANNOTATION_INSET,
  type DiffRange,
  type DiffSelection,
  fillPrimaryAction,
  fillReviewSlots,
  revealInDiff,
  revealStore,
  emptySurface,
  type ReviewAnnotation,
  type ReviewSlotProps,
  type ReviewSlots,
  type ReviewSurface,
  subjectKey,
  surfaceOf,
  surfaceStore,
  updateSurface,
} from "./surface.ts";

export { refreshPullDetail, usePullDetail, type PullDetail } from "./data/pullDetail.ts";

export { checkoutsOf } from "./data/source.ts";

export { pullReviewed } from "./data/advance.ts";

export { useMergeLeads } from "./merge/data/store.ts";

export type { ReviewFile } from "./model/layout.ts";

export { isDimmed } from "./model/findings.ts";
