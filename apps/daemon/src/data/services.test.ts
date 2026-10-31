import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("production Data services share agent approvals and persisted RPC Query Log", async () => {
  const root = mkdtempSync(join(tmpdir(), "data-services-"));

  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "services.testing.ts")], {
      env: { ...process.env, POLARIS_HOME: root },
      stdout: "ignore",
      stderr: "pipe",
    });

    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
