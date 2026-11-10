/** The mode warm-up (ENG-905): one chunk per idle period, in order; reaching for a mode hurries it. */
import { expect, test } from "bun:test";
import { createWarmup } from "./warmModes.ts";

/** Chunks whose imports the test resolves, and an idle queue it runs by hand. */
const harness = (count: number) => {
  const started: Array<number> = [];
  const finish: Array<() => void> = [];
  const idle: Array<() => void> = [];

  const chunks = Array.from({ length: count }, (_, i) => ({
    load: () => {
      started.push(i);

      return new Promise<object>((resolve) => finish.push(() => resolve({})));
    },
  }));

  const warmup = createWarmup(chunks, (run) => idle.push(run));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  return {
    warmup,
    started,
    idleRuns: () => idle.length,
    runIdle: () => idle.shift()?.(),
    finishLast: async () => {
      finish.at(-1)?.();
      await settle();
    },
  };
};

test("nothing loads until the renderer is idle, then one chunk per idle period, in order", async () => {
  const h = harness(3);

  h.warmup.start();
  expect(h.started).toEqual([]);

  h.runIdle();
  expect(h.started).toEqual([0]);
  // The next waits for this one and for another idle period.
  expect(h.idleRuns()).toBe(0);

  await h.finishLast();
  expect(h.started).toEqual([0]);
  h.runIdle();
  expect(h.started).toEqual([0, 1]);

  await h.finishLast();
  h.runIdle();
  await h.finishLast();
  expect(h.started).toEqual([0, 1, 2]);
  expect(h.idleRuns()).toBe(0);
});

test("reaching for a mode loads the rest back to back, still one at a time", async () => {
  const h = harness(3);

  h.warmup.start();
  h.warmup.now();
  expect(h.started).toEqual([0]);
  h.warmup.now();
  expect(h.started).toEqual([0]);

  await h.finishLast();
  expect(h.started).toEqual([0, 1]);
  await h.finishLast();
  expect(h.started).toEqual([0, 1, 2]);

  // The idle run queued at start finds nothing left.
  h.runIdle();
  expect(h.started).toEqual([0, 1, 2]);
});
