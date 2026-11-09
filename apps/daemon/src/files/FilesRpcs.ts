/**
 * Handlers for the `files.*` RPCs. The transport mounts this layer next to the
 * other partial handler layers of `DaemonRpcs`.
 */
import {
  EditorFileRpcs,
  FileEntry,
  FileError,
  Grep,
  ListDir,
  ReadFile,
  SearchPaths,
  Stat,
  WatchFiles,
} from "@polaris/protocol";
import { Effect, Layer, Stream } from "effect";
import { RpcGroup } from "effect/rpc";
import { noteFileRead } from "../memory/fileReads.ts";
import { BlobChannel, ServiceError } from "../services.ts";
import { EditorFilesRpcsLive } from "./EditorFilesRpcs.ts";
import { FileSearch } from "./FileSearch.ts";
import {
  type Entry,
  listDir,
  ReadContent,
  readRange,
  resolveHostPath,
  statPath,
  toFsFailure,
} from "./fs.ts";

export class FilesRpcs extends RpcGroup.make(
  ListDir,
  Stat,
  ReadFile,
  SearchPaths,
  Grep,
  WatchFiles
).merge(EditorFileRpcs) {}

const fileError = (path: string) => (cause: unknown) => {
  const failure = toFsFailure(resolveHostPath(path), cause);

  return new FileError({ path: failure.path, code: failure.code, message: failure.message });
};

const toFileEntry = (entry: Entry) => new FileEntry(entry);

export const handleListDir = Effect.fn("files.listDir")(function* ({
  path,
}: {
  readonly path: string;
}) {
  const entries = yield* Effect.tryPromise({ try: () => listDir(path), catch: fileError(path) });

  return entries.map(toFileEntry);
});

export const handleStat = Effect.fn("files.stat")(function* ({ path }: { readonly path: string }) {
  return toFileEntry(
    yield* Effect.tryPromise({ try: () => statPath(path), catch: fileError(path) })
  );
});

export const handleReadFile = Effect.fn("files.read")(function* ({
  path,
  offset,
  length,
}: typeof ReadFile.payloadSchema.Type) {
  const result = yield* Effect.tryPromise({
    try: () => readRange(path, offset, length),
    catch: fileError(path),
  });

  const { content } = result;

  if (ReadContent.$is("Inline")(content)) {
    noteFileRead(content.text.length);

    return { size: result.size, mimeType: result.mimeType, content };
  }

  const blobs = yield* BlobChannel;

  const blobId = yield* blobs.offer(
    ReadContent.$is("Bytes")(content)
      ? content.bytes
      : Stream.fromReadableStream({
          evaluate: () => Bun.file(content.path).slice(content.start, content.end).stream(),
          onError: (cause) =>
            new ServiceError({ service: "files.read", message: String(cause), cause }),
        }).pipe(Stream.onEnd(Effect.sync(() => noteFileRead(content.end - content.start))))
  );

  if (ReadContent.$is("Bytes")(content)) noteFileRead(content.bytes.byteLength);

  return {
    size: result.size,
    mimeType: result.mimeType,
    content: { _tag: "Blob" as const, blobId },
  };
});

export const handleSearchPaths = Effect.fn("files.searchPaths")(function* ({
  root,
  query,
  limit,
}: typeof SearchPaths.payloadSchema.Type) {
  const search = yield* FileSearch;

  return yield* search.searchPaths(root, query, limit);
});

export const handleGrep = Effect.fn("files.grep")(function* ({
  root,
  ...query
}: typeof Grep.payloadSchema.Type) {
  const search = yield* FileSearch;

  return yield* search.grep(root, query);
});

export const handleWatchFiles = ({ root }: { readonly root: string }) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const search = yield* FileSearch;

      return search.watch(root);
    })
  );

/**
 * Requires `FileSearch` (build with `FileSearchLive()`), and `BlobChannel` per
 * request for large reads.
 */
export const FilesRpcsLive = Layer.merge(
  EditorFilesRpcsLive,
  FilesRpcs.omit(
    "files.readVersioned",
    "files.write",
    "files.create",
    "files.rename",
    "files.delete",
    "files.watchFile"
  ).toLayer({
    "files.listDir": handleListDir,
    "files.stat": handleStat,
    "files.read": handleReadFile,
    "files.searchPaths": handleSearchPaths,
    "files.grep": handleGrep,
    "files.watch": handleWatchFiles,
  })
);
