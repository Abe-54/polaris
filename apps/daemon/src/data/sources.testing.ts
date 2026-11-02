import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SessionId } from "@polaris/protocol";
import { Effect } from "effect";
import { fileSecrets } from "../secrets/index.ts";
import { DataSourceAccess } from "./access.ts";
import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";

export const sessionId = SessionId.make("one");

export const manualInput = {
  sessionId,
  name: "private",
  engine: "postgres",
  host: "db.test",
  port: 5432,
  database: "app",
  user: "reader",
  label: { text: "STAGING", colour: "blue" },
} as const;

export const sourceFixture = Effect.gen(function* () {
  const root = newTempDir("data-security-", { short: true });
  mkdirSync(join(root, "other"));
  yield* Effect.addFinalizer(() => Effect.sync(() => removeTempDir(root)));
  const secrets = fileSecrets(join(root, "secrets"));
  const access = yield* DataSourceAccess.pipe(Effect.provide(DataSourceAccess.layer));

  return {
    root,
    secrets,
    options: {
      path: join(root, "data.sqlite"),
      secrets,
      access,
      checkout: (id: SessionId) =>
        Effect.succeed(id === SessionId.make("other") ? join(root, "other") : root),
    },
  };
});
