/** Traces is its own chunk, fetched the first time ⌘5 opens, so other modes never carry it. */
import { lazy, Suspense } from "react";

const View = lazy(() => import("./TracesMode.tsx").then((m) => ({ default: m.TracesMode })));

export const TracesMode = () => (
  <Suspense fallback={<div className="bg-ground flex-1" />}>
    <View />
  </Suspense>
);
