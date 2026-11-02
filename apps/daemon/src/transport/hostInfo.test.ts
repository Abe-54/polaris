import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Schema } from "effect";
import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";

test("hello and the CLI report the same dev build rather than a release placeholder", () => {
  const home = newTempDir("polaris-host-version-");

  try {
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dir, "fixtures/host-version.ts")],
      {
        env: { ...process.env, POLARIS_HOME: home, POLARIS_BUILD_VERSION: "0.0.0-dev.42.abcdef0" },
        encoding: "utf8",
        timeout: 10000,
      }
    );

    expect(result.status).toBe(0);

    const identity = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ daemonVersion: Schema.String, cli: Schema.String }))
    )(result.stdout);

    expect(identity.daemonVersion).toBe("0.0.0-dev.42.abcdef0");
    expect(identity.cli).toStartWith(`polaris ${identity.daemonVersion} `);
  } finally {
    removeTempDir(home);
  }
});
