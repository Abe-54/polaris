import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readEditorFile, writeEditorFile, requireEditorFiles } from "@polaris/client";
import { waitUntil } from "../../../../packages/bench/src/drive.ts";
import { Effect, Exit, Stream } from "effect";
import {
  awaitReady,
  cleanup,
  connect,
  createTempDir,
  launchDaemon,
} from "../../../../packages/bench/src/daemon.ts";
import { posixTest } from "../platform/testing.ts";

posixTest(
  "the bench Daemon launcher waits for a Unix socket file; Windows serves a named pipe (ENG-318)"
)(
  "a fake remote Host uses the bridge for versioned files, blobs and watches",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* Effect.acquireRelease(
            Effect.sync(() => createTempDir("editor-remote")),
            (dir) => Effect.sync(() => cleanup(dir))
          );

          const daemon = yield* Effect.acquireRelease(
            Effect.promise(() => launchDaemon({ home: null, binary: null })),
            (value) =>
              Effect.promise(async () => {
                await value.stop();
                cleanup(value.home);
              })
          );

          yield* waitUntil(() => existsSync(daemon.socketPath), 10000, "fake remote socket");
          yield* awaitReady(daemon);
          const client = yield* connect(daemon, "bridge", "fake-remote");
          expect(client.capabilities).toContain("files.write");
          expect(client.capabilities).toContain("files.watch-file");
          yield* requireEditorFiles(client.capabilities);
          const path = join(root, "large.ts");
          const text = "const greeting = '世界';\r\n".repeat(50000);
          yield* Effect.promise(() => writeFile(path, text));
          const read = yield* readEditorFile(client.connection, path);
          expect(read.text).toBe(text);

          const watched = yield* client.connection.client["files.watchFile"]({ path }).pipe(
            Stream.take(1),
            Stream.runCollect
          );

          expect(watched[0]?.version).toEqual(read.version);

          const version = yield* writeEditorFile(
            client.connection,
            path,
            text + "// saved\r\n",
            read.version
          );

          expect(version.size).toBe(new TextEncoder().encode(text + "// saved\r\n").length);

          const stale = yield* Effect.exit(
            writeEditorFile(client.connection, path, "stale", read.version)
          );

          expect(Exit.isFailure(stale)).toBe(true);
          expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(text + "// saved\r\n");
          const other = join(root, "new");
          yield* client.connection.client["files.create"]({ path: other, kind: "file" });
          yield* client.connection.client["files.rename"]({
            path: other,
            destination: other + "-renamed",
          });
          yield* client.connection.client["files.delete"]({
            path: other + "-renamed",
            permanent: true,
          });
          const unsupported = yield* Effect.exit(requireEditorFiles(["files.read"]));
          expect(Exit.isFailure(unsupported)).toBe(true);
        })
      )
    );
  },
  15000
);
