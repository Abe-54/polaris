import { expect, test } from "bun:test";
import { join } from "node:path";
import { newTempDir, removeTempDirSettled } from "../platform/tempDir.testing.ts";

const isolated = async (mode: string) => {
  const home = newTempDir("polaris-lazy-optional-");

  try {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "lazyOptional.testing.ts"), mode],
      {
        env: { ...process.env, POLARIS_HOME: home, POLARIS_BENCH_HARNESS: "1" },
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect({ code, stderr, stdout }).toMatchObject({ code: 0 });
  } finally {
    await removeTempDirSettled(home);
  }
};

test(
  "empty Daemon startup keeps Data, Traces, profiles, push encryption, decoders, the Reviewer, the Usage index, the accept handlers and computer use out of the implementation graph",
  () => isolated("empty"),
  30000
);

test(
  "concurrent first Data requests share source changes through MCP services and Client RPCs",
  () => isolated("data"),
  30000
);

test(
  "a trace receiver can activate on its first request after restart and reject a revoked endpoint",
  () => isolated("traces"),
  30000
);

test(
  "a migration checkout activates Data at its first Turn without a Client request",
  () => isolated("migrations"),
  30000
);

test(
  "existing Data storage recovers unfinished writes before any first-use request",
  () => isolated("recovery"),
  30000
);

test(
  "computer use loads with its first request after start, with the always-allowed apps saved before it",
  () => isolated("computer-use"),
  30000
);

test(
  "a terminal outside registered Workspaces does not initialize the trace runtime or store",
  () => isolated("unregistered-terminal"),
  30000
);
