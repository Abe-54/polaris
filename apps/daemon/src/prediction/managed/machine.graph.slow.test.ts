import { expect, test } from "bun:test";
import { decideManaged, managedInitial, type ManagedEvent } from "./machine.ts";

const signals: ManagedEvent[] = [
  { type: "setup" },
  { type: "downloaded" },
  { type: "download-failed" },
  { type: "cancel" },
  { type: "demand" },
  { type: "listening" },
  { type: "exit", retry: true },
  { type: "exit", retry: false },
  { type: "retry" },
  { type: "idle" },
  { type: "stop" },
];

const walk = (...events: ManagedEvent[]) =>
  events.reduce((state, event) => decideManaged(state, event), managedInitial());

test("every reachable state can be removed, and a request only starts a server that is on disk", () => {
  const seen = new Map([["absent", managedInitial()]]);
  const work = [managedInitial()];

  while (work.length > 0) {
    const previous = work.shift()!;
    expect(decideManaged(previous, { type: "remove" }).matches("absent")).toBe(true);
    expect(decideManaged(previous, { type: "unsupported" }).matches("unsupported")).toBe(true);

    for (const signal of signals) {
      const next = decideManaged(previous, signal);
      const key = String(next.value);

      if (!seen.has(key)) {
        seen.set(key, next);
        work.push(next);
      }
    }
  }

  expect([...seen.keys()].toSorted()).toEqual([
    "absent",
    "backoff",
    "downloading",
    "failed",
    "serving",
    "starting",
    "stopped",
  ]);
  expect(walk({ type: "demand" }).matches("absent")).toBe(true);
  expect(walk({ type: "setup" }, { type: "demand" }).matches("downloading")).toBe(true);
  expect(walk({ type: "setup" }, { type: "cancel" }).matches("absent")).toBe(true);
});

test("a crash backs off then retries; giving up fails; idle and stop return to stopped", () => {
  const serving = walk(
    { type: "setup" },
    { type: "downloaded" },
    { type: "demand" },
    { type: "listening" }
  );

  expect(serving.matches("serving")).toBe(true);

  const backoff = decideManaged(serving, { type: "exit", retry: true });
  expect(backoff.matches("backoff")).toBe(true);
  expect(decideManaged(backoff, { type: "retry" }).matches("starting")).toBe(true);
  expect(decideManaged(backoff, { type: "stop" }).matches("stopped")).toBe(true);
  expect(decideManaged(serving, { type: "exit", retry: false }).matches("failed")).toBe(true);
  expect(decideManaged(serving, { type: "idle" }).matches("stopped")).toBe(true);
  expect(decideManaged(serving, { type: "stop" }).matches("stopped")).toBe(true);
  const failed = decideManaged(serving, { type: "exit", retry: false });
  expect(decideManaged(failed, { type: "demand" }).matches("starting")).toBe(true);
  expect(
    decideManaged(walk({ type: "unsupported" }), { type: "setup" }).matches("unsupported")
  ).toBe(true);
});
