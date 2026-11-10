/**
 * Warms the lazy modes' chunks after first paint (ENG-905), so a first switch rarely waits: one
 * chunk per idle period, in the mode switch's order. Reaching for the switch, by pointer or a
 * modifier key, loads the rest back to back. Only imports: each mode's open effects run on render.
 */
import { dataChunk } from "../features/data/index.ts";
import { editChunk } from "../features/editor/explorer/index.ts";
import { requestsChunk } from "../features/requests/index.ts";
import { reviewChunk } from "../features/review/index.ts";
import { tracesChunk } from "../features/traces/index.ts";

/** A chunk to warm: `load` imports it, its module an object. */
export interface Warmable {
  readonly load: () => Promise<object>;
}

/** Runs `run` when the renderer is next idle. */
export type Idle = (run: () => void) => void;

export const createWarmup = (chunks: ReadonlyArray<Warmable>, idle: Idle) => {
  let next = 0;
  let loading = false;
  let waiting = false;
  let urgent = false;

  const step = () => {
    waiting = false;
    const chunk = chunks[next];

    if (chunk === undefined || loading) return;
    next += 1;
    loading = true;
    void chunk
      .load()
      .catch(() => undefined)
      .finally(() => {
        loading = false;

        if (urgent) step();
        else schedule();
      });
  };

  const schedule = () => {
    if (waiting || loading || next >= chunks.length) return;
    waiting = true;
    idle(step);
  };

  return {
    /** After first paint: the chunks one at a time, each when the renderer is idle. */
    start: schedule,
    /** The user is reaching for a mode: the rest load now, still one at a time. */
    now: () => {
      urgent = true;
      step();
    },
  };
};

// A deadline, so a renderer that is never idle (a busy stream) still warms within seconds.
const IDLE_DEADLINE_MS = 10_000;

export const modeWarmup = createWarmup(
  [reviewChunk, editChunk, dataChunk, tracesChunk, requestsChunk],
  (run) => requestIdleCallback(run, { timeout: IDLE_DEADLINE_MS })
);

/** A modifier going down may be ⌘2–⌘6 on its way: warm the rest at once. */
const onKeyDown = (event: KeyboardEvent) => {
  if (event.metaKey || event.ctrlKey) modeWarmup.now();
};

/** Starts the warm-up after the next paint; the returned function stops it waiting and listening. */
export const warmModes = () => {
  const frame = requestAnimationFrame(() => setTimeout(modeWarmup.start, 0));

  window.addEventListener("keydown", onKeyDown, { capture: true, passive: true });

  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("keydown", onKeyDown, { capture: true });
  };
};
