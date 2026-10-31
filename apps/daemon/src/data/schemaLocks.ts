/** Release idle keys after the last waiter; ordering lives only while operations overlap. */
import { Effect, Semaphore } from "effect";

export function keyedSnapshotGate() {
  const locks = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

  return <A, E, R>(key: string, work: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const entry = locks.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
      locks.set(key, entry);
      entry.users++;

      return entry.semaphore.withPermit(work).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            entry.users--;

            if (entry.users === 0) locks.delete(key);
          })
        )
      );
    });
}
