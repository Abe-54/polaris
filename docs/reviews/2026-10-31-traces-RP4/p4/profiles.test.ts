import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { Profile, ProfileId, Timestamp } from "../../../../packages/protocol/src/index.ts";
import { TEST_SESSION } from "../../../../apps/daemon/src/traces/testing.ts";
import { Profiles } from "../../../../apps/daemon/src/traces/profiles/index.ts";
import { cpuWork, withProfiles } from "../../../../apps/daemon/src/traces/profiles/testing.ts";
import {
  profileDirectory,
  profileJob,
} from "../../../../apps/daemon/src/traces/profiles/workerClient.ts";
import { isRunning } from "../../../../apps/daemon/src/platform/processes.ts";

const until = async (condition: () => boolean | Promise<boolean>, ms = 15000) => {
  const deadline = Date.now() + ms;

  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await Bun.sleep(25);
  }
};

// P4-1: restart (and Daemon shutdown) stop the profiled process with SIGTERM. Neither Node
// nor Bun writes a --cpu-prof artifact when killed by a signal, so the recording is lost.
for (const binary of ["node", "bun"])
  test(`finding P4-1: the ${binary} recording a restart ends keeps its CPU profile`, () =>
    withProfiles(async ({ root, runtime }) => {
      const script = join(root, "server.js");
      await writeFile(script, `${cpuWork} setInterval(()=>{},1000);`);
      const profiles = await runtime.runPromise(Profiles);

      const original = await runtime.runPromise(
        profiles.capture(TEST_SESSION, [binary, script], 0.01)
      );

      expect(original.status).toBe("recording");
      // Let the burn run so the old recording has real samples.
      await Bun.sleep(600);
      const next = await runtime.runPromise(profiles.restart(TEST_SESSION, original.pid));
      expect(next.status).toBe("recording");

      const ended = await runtime.runPromise(profiles.get(TEST_SESSION, original.id));
      expect(ended.profile.status).toBe("completed");
      expect(ended.hotFunctions.some((f) => f.name === "polarisBurn")).toBe(true);
    }), 30000);

// P4-2: the completion job of a finished process is rejected when 32 jobs are queued, the
// recording becomes "failed" and its artifact is never parsed, though it is still on disk.
test("finding P4-2: a process that exits while the profile queue is full still completes its recording", async () => {
  let hold = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const worker: typeof profileJob = async (job, changed) => {
    if (hold && job.operation === "list") await gate;

    return profileJob(job, changed);
  };

  await withProfiles(
    async ({ root, runtime }) => {
      const flag = join(root, "go");
      const script = join(root, "waits.js");

      await writeFile(
        script,
        `${cpuWork} const fs=require("fs"); const t=setInterval(()=>{ if (fs.existsSync(${JSON.stringify(flag)})) clearInterval(t) }, 20);`
      );
      const profiles = await runtime.runPromise(Profiles);

      const original = await runtime.runPromise(
        profiles.capture(TEST_SESSION, ["node", script], 0.01)
      );

      expect(original.status).toBe("recording");
      hold = true;

      // Reads such as Traces (⌘5) watch snapshots or list calls fill the shared queue.
      const reads = Array.from({ length: 32 }, () =>
        runtime.runPromise(profiles.list(TEST_SESSION)).catch(() => [])
      );

      await until(async () =>
        runtime.runPromise(
          profiles.list(TEST_SESSION).pipe(
            Effect.as(false),
            Effect.catch(() => Effect.succeed(true))
          )
        )
      );

      await writeFile(flag, "");
      await until(() => !isRunning(original.pid));
      await Bun.sleep(300);
      release();
      await Promise.all(reads);

      const detail = await runtime.runPromise(profiles.get(TEST_SESSION, original.id));
      expect(detail.profile.status).toBe("completed");
    },
    { worker }
  );
}, 30000);

// P4-3: retention counts an in-flight recording's bytes but can never evict it, so every
// finished recording in the checkout is deleted while one large recording is active.
test("finding P4-3: finished recordings are not evicted for bytes an active recording holds", async () => {
  const root = await mkdtemp("/tmp/rp4-ret-");
  const checkout = "/checkout";

  const recording = (id: string, status: Profile["status"], ageMs: number) =>
    Profile.make({
      id: ProfileId.make(id),
      command: "node test",
      runtime: "node",
      pid: 4242,
      turn: null,
      startedAt: Timestamp.make(new Date(Date.now() - ageMs).toISOString()),
      durationMs: status === "completed" ? 10 : 0,
      path: null,
      status,
      origin: "command",
    });

  const job = (
    operation: "start" | "list",
    id: string,
    active: string[],
    profile?: Profile
  ) =>
    profileJob({
      root,
      checkout,
      active,
      maxBytes: 4000,
      maxAgeMs: 7 * 86400_000,
      now: Date.now(),
      operation,
      id,
      ...(profile === undefined ? undefined : { profile }),
    });

  try {
    const finished = crypto.randomUUID();
    const active = crypto.randomUUID();
    await job("start", finished, [], recording(finished, "completed", 60_000));
    await job("start", active, [active], recording(active, "recording", 1000));

    // A child process of the profiled command (e.g. a test-runner fork) wrote its artifact.
    await writeFile(
      join(await profileDirectory(root, checkout, active), "CPU.1.2.9999.0.001.cpuprofile"),
      "x".repeat(8000)
    );

    const reply = await job("list", "", [active]);
    const ids = "profiles" in reply ? reply.profiles.map((p) => p.id) : [];
    expect(ids).toContain(active);
    expect(ids).toContain(finished);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

// P4-4: four never-exiting commands hold every capture slot on the Host (all checkouts) and
// nothing can stop them; the refusal then blames the Node or Bun installation.
test("finding P4-4: a capture refused because four recordings are active says so instead of blaming the installation", () =>
  withProfiles(async ({ root, runtime, addSession }) => {
    const script = join(root, "server.js");
    await writeFile(script, "setInterval(()=>{},1000);");
    const profiles = await runtime.runPromise(Profiles);

    for (let i = 0; i < 4; i++)
      expect(
        (await runtime.runPromise(profiles.capture(TEST_SESSION, ["node", script], 0.01))).status
      ).toBe("recording");

    const other = await addSession("other-checkout", { checkout: join(root, "other") });

    const refused = await runtime.runPromise(
      profiles.capture(other, ["node", "-e", "1"], 1).pipe(Effect.flip)
    );

    expect(refused.fix).not.toContain("Node or Bun installation");
    expect(`${refused.message} ${refused.fix}`).toMatch(/limit|four|active recordings/i);
  }), 30000);
