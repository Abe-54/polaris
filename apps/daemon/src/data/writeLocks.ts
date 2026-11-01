/** Only writes to the same target queue together; idle targets retain no lock. */
import { Effect, Semaphore } from "effect";

export function targetLocks() {
  const locks = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

  return <A, E>(key: string, work: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      let lock = locks.get(key);

      if (!lock) {
        lock = { semaphore: yield* Semaphore.make(1), users: 0 };
        locks.set(key, lock);
      }

      lock.users++;
      const current = lock;

      return yield* current.semaphore
        .withPermits(1)(work)
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (--current.users === 0) locks.delete(key);
            })
          )
        );
    });
}
