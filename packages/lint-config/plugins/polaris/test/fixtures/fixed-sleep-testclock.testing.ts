import { Effect } from "effect";
import { TestClock } from "effect/testing";

export const virtual = Effect.gen(function* () {
  yield* Effect.forkChild(Effect.sleep("1 minute"));
  yield* TestClock.adjust("1 minute");
});

// TestClock drives Effect's clock only: this one still waits for real.
export const real = () => Bun.sleep(500);
