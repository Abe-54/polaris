/** Data's local persistence, scoped to the Daemon; no polling or cleanup interval. */
import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { DataError } from "@polaris/protocol";
import { polarisHome } from "../paths.ts";

export const storageError = () =>
  new DataError({
    code: "E-DATA-UNREACHABLE",
    message: "Polaris couldn't save the data record on this host.",
    fix: "Check the host's storage and retry.",
  });

export class DataDatabase extends Context.Service<DataDatabase, { readonly db: Database }>()(
  "polaris/data/Database"
) {
  static layerAt = (filename: string) =>
    Layer.effect(
      DataDatabase,
      Effect.gen(function* () {
        const db = yield* Effect.try({
          try: () => {
            if (filename !== ":memory:")
              mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
            const database = new Database(filename, { create: true });

            if (filename !== ":memory:" && process.platform !== "win32") chmodSync(filename, 0o600);
            database.exec("PRAGMA busy_timeout=5000");

            return database;
          },
          catch: storageError,
        });

        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()));

        return { db };
      })
    );
  static readonly layer = Layer.suspend(() =>
    DataDatabase.layerAt(join(polarisHome(), "data.sqlite"))
  );
}
