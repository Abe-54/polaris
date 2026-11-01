/** Run under the Host bench lease: alternating native Node starts with and without the bootstrap. */
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { SessionId } from "@polaris/protocol";
import { executableOf } from "../../platform/executable.ts";
import { TargetRegistry } from "./registry.ts";

export const measureStartup = async () => {
  const root = await mkdtemp("/tmp/p9-startup-");
  const registry = new TargetRegistry(join(root, "bootstrap"));

  const base = {
    ...process.env,
    NODE_OPTIONS: "",
    POLARIS_PROFILE_SOCKET: "",
    POLARIS_PROFILE_TOKEN: "",
  };

  const injected = { ...base, ...(await registry.environment(SessionId.make("startup"))) };

  const run = async (env: typeof base) => {
    const start = performance.now();

    const child = Bun.spawn([executableOf("node"), "-e", "0"], {
      env,
      stdout: "ignore",
      stderr: "pipe",
    });

    if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());

    return performance.now() - start;
  };

  try {
    for (let n = 0; n < 3; n++) {
      await run(base);
      await run(injected);
    }

    const before: number[] = [];
    const after: number[] = [];

    for (let n = 0; n < 20; n++) {
      if (n % 2 === 0) {
        before.push(await run(base));
        after.push(await run(injected));
      } else {
        after.push(await run(injected));
        before.push(await run(base));
      }
    }

    const median = (values: number[]) => {
      const sorted = values.toSorted((a, b) => a - b);

      return (sorted[9]! + sorted[10]!) / 2;
    };

    const baselineMs = median(before);
    const bootstrapMs = median(after);

    return { before, after, baselineMs, bootstrapMs, addedMs: bootstrapMs - baselineMs };
  } finally {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const result = await measureStartup();
  console.log(JSON.stringify(result, null, 2));

  if (result.addedMs >= 15) process.exitCode = 1;
}
