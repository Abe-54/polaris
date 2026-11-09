import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, PubSub, Queue, Stream } from "effect";
import { FileSearch } from "../files/FileSearch.ts";
import { tempDir } from "../platform/tempDir.testing.ts";
import { watchSnapshot } from "./rpcs.ts";

/** A tree watcher that never arms, as on a slow first index. */
const unarmed = FileSearch.of({
  searchPaths: () => Effect.succeed([]),
  grep: () => Effect.succeed([]),
  watchIndexedFile: () => Effect.void,
  watch: () => Stream.never,
  backendOf: () => Effect.succeed(null),
});

test("a save from Requests reaches an open watch before the tree watcher has armed", async () => {
  const root = tempDir("rq-watch-");
  writeFileSync(join(root, "api.http"), "### List\nGET https://a.example/\n");
  mkdirSync(join(root, "deep", "er"), { recursive: true });

  const files = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const saves = yield* PubSub.unbounded<string>();
        const snapshots = yield* Queue.unbounded<ReadonlyArray<string>>();

        yield* Effect.forkScoped(
          Stream.runForEach(watchSnapshot(unarmed, root, 10, saves), (snapshot) =>
            Queue.offer(
              snapshots,
              snapshot.files.map((file) => file.path)
            )
          )
        );

        const take = Queue.take(snapshots).pipe(Effect.timeout("3 seconds"));
        expect(yield* take).toEqual(["api.http"]);

        // No directory watch covers deep/er: only the save itself can tell the watch.
        writeFileSync(join(root, "deep", "er", "new.http"), "### New\nGET https://b.example/\n");
        yield* PubSub.publish(saves, root);

        return yield* take;
      })
    )
  );

  expect(files).toEqual(["api.http", "deep/er/new.http"]);
});
