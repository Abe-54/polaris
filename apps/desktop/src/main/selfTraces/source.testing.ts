/** A Developer Mode source the test sets by hand. */
import type { SelfTraceGate } from "@polaris/client";
import type { DeveloperModeSource } from "./source.ts";

export const testDeveloperModeSource = (initial: SelfTraceGate) => {
  let gate = initial;
  const listeners = new Set<(gate: SelfTraceGate) => void>();

  const source: DeveloperModeSource = {
    current: () => gate,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };

  const set = (next: SelfTraceGate) => {
    gate = next;

    for (const listener of listeners) listener(next);
  };

  return { source, set };
};
