/**
 * Counts the file bytes read since the last release, so a burst of reads can ask for one. Plain
 * functions, since file reads run outside any Layer. See docs/adr/0010-release-memory-when-quiet.md.
 */
import { Effect, Queue, Stream } from "effect";

/** Read garbage worth a release: under the 5 MiB a steady memory gate tolerates (README). */
export const RELEASE_AFTER_READ_BYTES = 4 * 1024 * 1024;

const listeners = new Set<() => void>();

let unreleased = 0;

export const noteFileRead = (bytes: number) => {
  unreleased += bytes;

  if (unreleased >= RELEASE_AFTER_READ_BYTES) for (const listener of listeners) listener();
};

export const clearFileReads = () => {
  unreleased = 0;
};

/** One element per read once enough has piled up. Costs nothing until a read notes itself. */
export const fileReadBursts = Stream.callback<void>(
  (queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const listener = () => void Queue.offerUnsafe(queue, undefined);
        listeners.add(listener);

        return listener;
      }),
      (listener) => Effect.sync(() => void listeners.delete(listener))
    ),
  { bufferSize: 1, strategy: "sliding" }
);
