/** Opt-in native acceptance; the child imports the real Daemon service composition. */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { shortTemp } from "../../platform/testing.ts";

const target = process.env.POLARIS_DATA_POSTGRES_URL;

test.skipIf(target === undefined)(
  "postgres Data tools through the production Engine/MCP composition",
  async () => {
    const root = mkdtempSync(shortTemp("pl-mx-real-"));

    try {
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "data.real.testing.ts"), "postgres"],
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
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000
);
