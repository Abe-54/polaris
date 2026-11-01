import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DeveloperModeError, WorkspaceId } from "@polaris/protocol";
import { Effect, Option, Schema } from "effect";

/** What `developer-mode.json` holds: the stored setting and the Polaris Workspace override. */
export const StoredDeveloperMode = Schema.Struct({
  stored: Schema.Boolean,
  workspaceId: Schema.NullOr(WorkspaceId),
});

export type StoredDeveloperMode = typeof StoredDeveloperMode.Type;

const Json = Schema.fromJsonString(StoredDeveloperMode);

const decode = Schema.decodeUnknownOption(Json);

const encode = Schema.encodeSync(Json);

const OFF: StoredDeveloperMode = { stored: false, workspaceId: null };

/** The file at `path`; a missing or unreadable one is off with no override. */
export const developerModeFile = (path: string) => ({
  read: Effect.promise(() => readFile(path, "utf8").catch(() => null)).pipe(
    Effect.map((text) => (text === null ? OFF : Option.getOrElse(decode(text), () => OFF)))
  ),
  // Written to a temporary file and renamed, so a crash never leaves half a file.
  write: (value: StoredDeveloperMode) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.${process.pid}.tmp`;
        await writeFile(temporary, encode(value));
        await rename(temporary, path);
      },
      catch: (cause) =>
        new DeveloperModeError({
          reason: "storage",
          message: `Could not save Developer Mode: ${String(cause)}`,
        }),
    }),
});
