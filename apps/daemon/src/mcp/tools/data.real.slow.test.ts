import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";
/** Opt-in native acceptance; the child imports the real Daemon service composition. */
import { expect, test } from "bun:test";
import { join } from "node:path";

for (const [engine, target] of [
  ["mysql", process.env.POLARIS_DATA_MYSQL_URL],
  ["postgres", process.env.POLARIS_DATA_POSTGRES_URL],
] as const)
  test.skipIf(target === undefined)(
    `${engine} Data tools through the production Engine/MCP composition`,
    async () => {
      const root = newTempDir("pl-mx-real-", { short: true });

      try {
        const child = Bun.spawn(
          [process.execPath, join(import.meta.dir, "data.real.testing.ts"), engine],
          {
            env: { ...process.env, POLARIS_HOME: root },
            stdout: "pipe",
            stderr: "pipe",
          }
        );

        const [exit, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);

        expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: "", stderr: "" });
      } finally {
        removeTempDir(root);
      }
    },
    60_000
  );
