/**
 * Search indexes, one per root (a Workspace or a Worktree), built lazily on
 * the first search or watch and dropped after `idleMs` without use and with
 * no active watcher (default 10 minutes). Each index is fff when its native
 * library loads, else the fallback backend.
 */
import { realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { FileError } from "@polaris/protocol";
import { Context, Effect, Layer, Queue, type Scope, Stream } from "effect";
import { interruptibleGit, uninterrupted } from "../git/interrupt.ts";
import { resolveHostPath, toFsFailure } from "./fs.ts";
import { openFallbackBackend } from "./search/fallback.ts";
import { openFffBackend } from "./search/fff.ts";
import type { FileChange, GrepHit, GrepQuery, PathHit, SearchBackend } from "./search/types.ts";

export interface FileSearchOptions {
  /** Drop an index after this long without a search and with no watcher. */
  readonly idleMs: number;
  /** How often idle indexes are looked for (only while there are any: an idle Daemon sleeps). */
  readonly sweepMs: number;
  /** Set false to force the fallback backend (tests; `POLARIS_FFF=off` does the same). */
  readonly useFff: boolean;
}

export const defaultFileSearchOptions: FileSearchOptions = {
  idleMs: 10 * 60_000,
  sweepMs: 60_000,
  useFff: true,
};

export class FileSearch extends Context.Service<
  FileSearch,
  {
    readonly searchPaths: (
      root: string,
      query: string,
      limit: number
    ) => Effect.Effect<ReadonlyArray<PathHit>, FileError>;
    readonly grep: (
      root: string,
      query: GrepQuery
    ) => Effect.Effect<ReadonlyArray<GrepHit>, FileError>;
    /** Reuse an existing fff index; never starts an index for an open tab. */
    readonly watchIndexedFile: (
      path: string,
      changed: () => void
    ) => Effect.Effect<void, FileError, Scope.Scope>;
    readonly watch: (root: string) => Stream.Stream<ReadonlyArray<FileChange>, FileError>;
    /** Which backend serves `root` right now, if it has an index (diagnostics and tests). */
    readonly backendOf: (root: string) => Effect.Effect<SearchBackend["kind"] | null>;
  }
>()("polaris/daemon/files/FileSearch") {}

interface Index {
  readonly backend: Promise<SearchBackend>;
  lastUsed: number;
  watchers: number;
  /** Searches in flight: an index is never dropped under one. */
  busy: number;
}

const fileError = (path: string, cause: unknown) => {
  const failure = toFsFailure(path, cause);

  return new FileError({ path: failure.path, code: failure.code, message: failure.message });
};

const canonicalRoot = async (input: string): Promise<string> => {
  const path = resolveHostPath(input);
  const real = await realpath(path);
  const stats = await stat(real);

  if (!stats.isDirectory()) {
    throw Object.assign(new Error(`not a directory: ${path}`), { code: "ENOTDIR" });
  }

  return real;
};

export const makeFileSearch = (options: FileSearchOptions) =>
  Effect.gen(function* () {
    const indexes = new Map<string, Index>();
    let timer: ReturnType<typeof setInterval> | undefined;

    const open = (root: string): Index => {
      const existing = indexes.get(root);

      if (existing !== undefined) {
        existing.lastUsed = Date.now();

        return existing;
      }

      const backend = (options.useFff ? openFffBackend(root) : Promise.resolve(null)).then(
        (fff) => fff ?? openFallbackBackend(root)
      );

      const index: Index = { backend, lastUsed: Date.now(), watchers: 0, busy: 0 };
      indexes.set(root, index);
      timer ??= setInterval(sweep, options.sweepMs);

      return index;
    };

    const drop = (root: string, index: Index) => {
      indexes.delete(root);
      void index.backend.then((backend) => backend.dispose());
    };

    const sweep = () => {
      const now = Date.now();

      for (const [root, index] of indexes) {
        if (index.watchers === 0 && index.busy === 0 && now - index.lastUsed > options.idleMs) {
          drop(root, index);
        }
      }

      if (indexes.size === 0) {
        clearInterval(timer);
        timer = undefined;
      }
    };

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        clearInterval(timer);

        for (const [root, index] of indexes) drop(root, index);
      })
    );

    /**
     * The index is shared, so it opens out of reach of this caller's interrupt; only the
     * search runs under it, and an interrupt kills its git (ENG-364).
     */
    const withBackend = <A extends PathHit | GrepHit>(
      input: string,
      f: (backend: SearchBackend) => Promise<ReadonlyArray<A>>
    ) =>
      Effect.gen(function* () {
        const requestedRoot = resolveHostPath(input);
        const failed = (cause: unknown) => fileError(requestedRoot, cause);

        const root = yield* Effect.tryPromise({
          try: () => canonicalRoot(requestedRoot),
          catch: failed,
        });

        const index = uninterrupted(() => open(root));

        const hits = yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            index.busy++;
          }),
          () =>
            Effect.tryPromise({ try: () => index.backend, catch: failed }).pipe(
              Effect.flatMap((backend) =>
                interruptibleGit({ try: () => f(backend), catch: failed })
              )
            ),
          () =>
            Effect.sync(() => {
              index.busy--;
              index.lastUsed = Date.now();
            })
        );

        // Indexes share real roots; each response keeps the caller's Workspace spelling.
        return root === requestedRoot
          ? hits
          : hits.map((hit) => ({ ...hit, path: join(requestedRoot, relative(root, hit.path)) }));
      });

    return FileSearch.of({
      searchPaths: (root, query, limit) =>
        withBackend(root, (backend) => backend.searchPaths(query, Math.max(0, limit))),
      grep: (root, query) =>
        withBackend(root, (backend) => backend.grep({ ...query, limit: Math.max(0, query.limit) })),
      watchIndexedFile: (path, changed) =>
        Effect.gen(function* () {
          const match = [...indexes.entries()]
            .filter(([root]) => path.startsWith(root + sep))
            .sort(([a], [b]) => b.length - a.length)[0];

          if (!match) return;
          const [root, index] = match;

          yield* Effect.acquireRelease(
            Effect.sync(() => {
              index.watchers++;
            }),
            () =>
              Effect.sync(() => {
                index.watchers--;
                index.lastUsed = Date.now();
              })
          );

          const backend = yield* Effect.tryPromise({
            try: () => index.backend,
            catch: (cause) => fileError(path, cause),
          });

          if (backend.kind !== "fff") return;
          yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () =>
                backend.watch((batch) => {
                  if (batch.some((event) => event.path === path || event.path === root)) changed();
                }),
              catch: (cause) => fileError(path, cause),
            }),
            (stop) => Effect.sync(stop)
          );
        }),
      watch: (input) =>
        Stream.callback<ReadonlyArray<FileChange>, FileError>((queue) =>
          Effect.gen(function* () {
            const root = yield* Effect.tryPromise({
              try: () => canonicalRoot(input),
              catch: (cause) => fileError(resolveHostPath(input), cause),
            });

            const index = open(root);
            index.watchers++;
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                index.watchers--;
                index.lastUsed = Date.now();
              })
            );

            const backend = yield* Effect.tryPromise({
              try: () => index.backend,
              catch: (cause) => fileError(root, cause),
            });

            // acquireRelease: an interrupt while the watcher is arming still unsubscribes.
            yield* Effect.acquireRelease(
              Effect.tryPromise({
                try: () => backend.watch((batch) => Queue.offerUnsafe(queue, batch)),
                catch: (cause) => fileError(root, cause),
              }),
              (stop) => Effect.sync(stop)
            );
          }).pipe(
            // The callback runs forked: without this a missing root would hang the stream silently.
            Effect.catch((error) => Queue.fail(queue, error))
          )
        ),
      backendOf: (input) =>
        Effect.promise(async () => {
          const root = await canonicalRoot(input).catch(() => null);
          const index = root === null ? undefined : indexes.get(root);

          return index === undefined ? null : (await index.backend).kind;
        }),
    });
  });

export const FileSearchLive = (options: Partial<FileSearchOptions> = {}) =>
  Layer.effect(FileSearch, makeFileSearch({ ...defaultFileSearchOptions, ...options }));
