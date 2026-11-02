import { expect, test } from "bun:test";
import { decideLifecycle, lifecycleInitial, type LifecycleEvent } from "./lifecycle.ts";

const signals: LifecycleEvent[] = [
  { type: "demand" },
  { type: "ready" },
  { type: "empty" },
  { type: "grace" },
  { type: "evict" },
  { type: "crash", retry: true },
  { type: "crash", retry: false },
  { type: "retry" },
  { type: "revoke" },
  { type: "disconnect" },
  { type: "stop" },
  { type: "window", attempts: 0 },
  { type: "restart" },
  { type: "change" },
];

test("all reachable lifecycle nodes obey stop/revoke and bounded retry routing", () => {
  const seen = new Map([["stopped", lifecycleInitial()]]);
  const work = [lifecycleInitial()];

  while (work.length > 0) {
    const previous = work.shift()!;
    expect(decideLifecycle(previous, { type: "disconnect" }).matches("stopped")).toBe(true);
    expect(decideLifecycle(previous, { type: "revoke" }).matches("untrusted")).toBe(true);

    for (const signal of signals) {
      const next = decideLifecycle(previous, signal);
      const key = String(next.value);

      if (!seen.has(key)) {
        seen.set(key, next);
        work.push(next);
      }
    }
  }

  expect([...seen.keys()].toSorted()).toEqual([
    "backoff",
    "failed",
    "grace",
    "ready",
    "starting",
    "stopped",
    "untrusted",
  ]);
  const starting = decideLifecycle(lifecycleInitial(), { type: "demand" });
  const ready = decideLifecycle(starting, { type: "ready" });
  expect(decideLifecycle(ready, { type: "evict" }).matches("ready")).toBe(true);
  const idle = decideLifecycle(ready, { type: "empty" });
  expect(decideLifecycle(idle, { type: "evict" }).matches("stopped")).toBe(true);
  expect(decideLifecycle(starting, { type: "crash", retry: false }).matches("failed")).toBe(true);
  const failed = decideLifecycle(starting, { type: "crash", retry: false });
  expect(decideLifecycle(failed, { type: "demand" }).matches("failed")).toBe(true);
  expect(decideLifecycle(failed, { type: "change" }).matches("failed")).toBe(true);
});
