import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { isRunning, system32 } from "./processes.ts";
import { loopbackListeners, processCreated, spawnInJob } from "./windowsNative.ts";
import { newTempDir, removeTempDirSettled } from "./tempDir.testing.ts";

const windowsOnly = test.skipIf(process.platform !== "win32");

/** `ping` for a while: a grandchild of the job's cmd.exe, as codex.exe is of the shim's. */
const pingArgv = (seconds: number) => [
  system32("cmd.exe"),
  "/d",
  "/c",
  `${system32("PING.EXE")} -n ${seconds} 127.0.0.1`,
];

const waitUntil = async (done: () => boolean, ms = 5000) => {
  for (let waited = 0; waited < ms && !done(); waited += 50) await Bun.sleep(50);

  return done();
};

const logged = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

describe("Windows natives", () => {
  windowsOnly("the listener table names this process on a port it binds", () => {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });

    try {
      expect(loopbackListeners()).toContainEqual({ port: server.port, pid: process.pid });
    } finally {
      server.stop(true);
    }
  });

  windowsOnly("a creation time names one process, and a gone one has none", () => {
    expect(processCreated(process.pid)).toBe(processCreated(process.pid));
    expect(processCreated(process.pid)! > 0n).toBe(true);
    expect(processCreated(0x7fff_fff0)).toBeNull();
  });

  windowsOnly(
    "what a job's child starts is in the job, and stopping it ends them all",
    async () => {
      const dir = newTempDir("pjob-");
      const job = spawnInJob({ argv: pingArgv(30), env: process.env, logFile: join(dir, "log") });

      try {
        expect(await waitUntil(() => job.pids().length >= 2)).toBe(true);
        // Its stdout reaches the log, appended; ping's first line can trail the spawn.
        expect(await waitUntil(() => logged(join(dir, "log")).includes("127.0.0.1"))).toBe(true);
        const pids = job.pids();

        expect(pids).toContain(job.pid);
        await job.stop();
        expect(pids.filter(isRunning)).toEqual([]);
      } finally {
        await job.stop();
        await removeTempDirSettled(dir);
      }
    }
  );

  windowsOnly("a parent killed outright takes its job's whole tree with it", async () => {
    const dir = newTempDir("pjob-");
    const script = join(dir, "parent.ts");
    const native = join(import.meta.dir, "windowsNative.ts");
    const argv = JSON.stringify(pingArgv(60));

    await Bun.write(
      script,
      `import { spawnInJob } from ${JSON.stringify(native)};
const job = spawnInJob({ argv: ${argv}, env: process.env, logFile: ${JSON.stringify(join(dir, "log"))} });
while (job.pids().length < 2) await Bun.sleep(50);
console.log(JSON.stringify(job.pids()));
setInterval(() => {}, 1000);`
    );
    const parent = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "inherit" });

    try {
      const reader = parent.stdout.getReader();
      const { value } = await reader.read();
      // SAFETY: the script above prints one JSON array of pids before anything else.
      const pids = JSON.parse(new TextDecoder().decode(value)) as Array<number>;

      expect(pids.filter(isRunning).length).toBeGreaterThanOrEqual(2);
      // TerminateProcess: no finalizer runs, as when the Daemon is killed.
      parent.kill("SIGKILL");
      expect(await waitUntil(() => pids.filter(isRunning).length === 0)).toBe(true);
    } finally {
      parent.kill("SIGKILL");
      await removeTempDirSettled(dir);
    }
  });

  // JSC tiers up early, so a buffer only a dead local held is really unreachable (ADR 0066).
  const eagerJit = {
    BUN_JSC_thresholdForJITAfterWarmUp: "5",
    BUN_JSC_thresholdForJITSoon: "5",
    BUN_JSC_thresholdForOptimizeAfterWarmUp: "10",
    BUN_JSC_thresholdForOptimizeSoon: "10",
    BUN_JSC_thresholdForFTLOptimizeAfterWarmUp: "20",
    BUN_JSC_thresholdForFTLOptimizeSoon: "20",
    BUN_JSC_useConcurrentJIT: "0",
  };

  windowsOnly(
    "a job's child starts while collections run as its environment is read, JIT-compiled",
    async () => {
      const dir = newTempDir("pjob-");
      const script = join(dir, "stress.ts");
      const native = join(import.meta.dir, "windowsNative.ts");
      const cmd = system32("cmd.exe");

      // Reading the environment collects, then refills the heap with same-sized garbage.
      await Bun.write(
        script,
        `import { spawnInJob } from ${JSON.stringify(native)};
let held = [];
const env = { ...process.env };
Object.defineProperty(env, "POLARIS_GC_PROBE", { enumerable: true, get: () => {
  Bun.gc(true);
  held = [];
  for (const bytes of [16, 24, 112, ${(cmd.length + 1) * 2}, ${(cmd.length + 40) * 2}])
    for (let i = 0; i < 500; i++) held.push(Buffer.alloc(bytes, 0x41));
  return "1";
} });
const failures = {};
for (let i = 0; i < 400; i++) {
  try {
    const job = spawnInJob({ argv: [${JSON.stringify(cmd)}, "/d", "/c", "exit 0"], env, logFile: ${JSON.stringify(join(dir, "log"))} });
    await job.stop();
  } catch (error) {
    failures[error.message] = (failures[error.message] ?? 0) + 1;
  }
}
console.log(JSON.stringify(failures));`
      );

      try {
        const child = Bun.spawn([process.execPath, script], {
          env: { ...process.env, ...eagerJit },
          stdout: "pipe",
          stderr: "inherit",
        });

        const output = await new Response(child.stdout).text();

        expect(await child.exited).toBe(0);
        expect(JSON.parse(output)).toEqual({});
      } finally {
        await removeTempDirSettled(dir);
      }
    },
    60_000
  );
});
