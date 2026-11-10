/** `computer-use.json` in the Polaris home: whether computer use is on, and the always-allowed apps. */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AllowedApp } from "@polaris/protocol";
import { Effect, Option, Schema } from "effect";

export const StoredComputerUse = Schema.Struct({
  enabled: Schema.Boolean,
  allowed: Schema.Array(AllowedApp),
});

export type StoredComputerUse = typeof StoredComputerUse.Type;

const Json = Schema.fromJsonString(StoredComputerUse);

const decode = Schema.decodeUnknownOption(Json);

const encode = Schema.encodeSync(Json);

export const OFF: StoredComputerUse = { enabled: false, allowed: [] };

export class ComputerUseStorageError extends Schema.TaggedError<ComputerUseStorageError>()(
  "ComputerUseStorageError",
  { message: Schema.String }
) {}

/** The file at `path`; a missing or unreadable one is off with no apps. */
export const computerUseFile = (path: string) => ({
  read: Effect.promise(() => readFile(path, "utf8").catch(() => null)).pipe(
    Effect.map((text) => (text === null ? OFF : Option.getOrElse(decode(text), () => OFF)))
  ),
  // Written to a temporary file and renamed, so a crash never leaves half a file.
  write: (value: StoredComputerUse) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.${process.pid}.tmp`;
        await writeFile(temporary, encode(value), { mode: 0o600 });
        await rename(temporary, path);
      },
      catch: (cause) =>
        new ComputerUseStorageError({
          message: `Could not save computer use settings: ${String(cause)}`,
        }),
    }),
});
