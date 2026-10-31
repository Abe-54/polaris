/** Data mode is its own chunk, fetched the first time ⌘4 opens, so other modes never carry it. */
import { lazy, Suspense } from "react";

const View = lazy(() => import("./DataMode.tsx").then((m) => ({ default: m.DataMode })));

export const DataMode = () => (
  <Suspense fallback={<div className="bg-ground flex-1" />}>
    <View />
  </Suspense>
);
