/**
 * The Review view is its own chunk (Pierre Diffs and Shiki's core are ~600 KB minified). The app
 * warms it after first paint and again while the pull request list shows (ENG-905); until it has
 * loaded, the queue and panels show empty in its place.
 */
import { Horizon, Panel } from "@polaris/ui";
import { type ComponentType, Suspense } from "react";
import { type ModeChunk, modeChunk, useModeChunk } from "../../../shell/modeChunk.ts";
import type { ReviewViewProps } from "./ReviewView.tsx";

/** What the wrapper takes from the chunk. */
export interface ReviewChunk {
  readonly ReviewView: ComponentType<ReviewViewProps>;
}

export const reviewChunk = modeChunk<ReviewChunk>(() => import("./ReviewView.tsx"));

const View = ({ chunk, ...props }: ReviewViewProps & { chunk: ModeChunk<ReviewChunk> }) => {
  const { ReviewView: Loaded } = useModeChunk(chunk);

  return <Loaded {...props} />;
};

let preloaded = false;

/** Fetch the chunk when the renderer is idle; once. */
export const preloadReview = () => {
  if (preloaded) return;

  preloaded = true;
  requestIdleCallback(() => void reviewChunk.load(), { timeout: 5000 });
};

/** The queue on the ground, the centre panel and the risk column, empty. */
const ReviewShell = () => (
  <div className="relative isolate flex min-h-0 flex-1 gap-2 pr-2" aria-busy="true">
    <nav aria-label="Review queue" className="flex w-[288px] shrink-0 flex-col pt-2 pr-3 pl-4">
      <span className="px-gap text-title text-text-strong pb-1.5 font-semibold">Review</span>
    </nav>
    <Panel asChild className="mb-2 min-w-0 flex-1">
      <section aria-label="Review panel" />
    </Panel>
    <Panel asChild className="mb-2 w-[360px] shrink-0">
      <aside aria-label="Risk summary" />
    </Panel>
    <Horizon />
  </div>
);

/** The Review view over `chunk`; tests pass one whose import they control. */
export const reviewViewOver = (chunk: ModeChunk<ReviewChunk>) => (props: ReviewViewProps) => (
  <Suspense fallback={<ReviewShell />}>
    <View chunk={chunk} {...props} />
  </Suspense>
);

export const ReviewView = reviewViewOver(reviewChunk);
