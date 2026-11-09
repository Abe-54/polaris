/** Requests is its own chunk, fetched the first time ⌘6 opens, so other modes never carry it. */
import { lazy, Suspense } from "react";

const View = lazy(() => import("./RequestsMode.tsx").then((m) => ({ default: m.RequestsMode })));

export const RequestsMode = () => (
  <Suspense fallback={<div className="bg-ground flex-1" />}>
    <View />
  </Suspense>
);
