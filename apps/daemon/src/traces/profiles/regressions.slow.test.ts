import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { Profile, ProfileId, Timestamp } from "@polaris/protocol";
import { TEST_SESSION } from "../testing.ts";
import { Profiles } from "./index.ts";
import { cpuWork, withProfiles } from "./testing.ts";
import { profileDirectory, profileJob } from "./workerClient.ts";
import { isRunning, killTree } from "../../platform/processes.ts";

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
  test(
    `P4-1: the ${binary} recording a restart ends keeps its CPU profile`,
    () =>
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
      }),
    30000
  );

// P4-2: the completion job of a finished process is rejected when 32 jobs are queued, the
// recording becomes "failed" and its artifact is never parsed, though it is still on disk.
test("P4-2: a process that exits while the profile queue is full still completes its recording", async () => {
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
      let refusals = 0;

      const reads = Array.from({ length: 33 }, () =>
        runtime.runPromise(profiles.list(TEST_SESSION)).catch(() => {
          refusals++;

          return [];
        })
      );

      try {
        await until(() => refusals > 0);
        await writeFile(flag, "");
        await until(() => !isRunning(original.pid));
        await Bun.sleep(300);
      } finally {
        release();
      }

      await Promise.all(reads);

      const detail = await runtime.runPromise(profiles.get(TEST_SESSION, original.id));
      expect(detail.profile.status).toBe("completed");
    },
    { worker }
  );
}, 30000);

// P4-3: retention counts an in-flight recording's bytes but can never evict it, so every
// finished recording in the checkout is deleted while one large recording is active.
test("P4-3: finished recordings are not evicted for bytes an active recording holds", async () => {
  const root = newTempDir("rp4-ret-", { short: true });
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

  const job = (operation: "start" | "list", id: string, active: string[], profile?: Profile) =>
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
    const finished = ProfileId.make(crypto.randomUUID());
    const active = ProfileId.make(crypto.randomUUID());
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
    await removeTempDirSettled(root);
  }
}, 30000);

// P4-4: four never-exiting commands hold every capture slot on the Host (all checkouts) and
// nothing can stop them; the refusal then blames the Node or Bun installation.
test(
  "P4-4: a capture refused because four recordings are active says so instead of blaming the installation",
  () =>
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
    }),
  30000
);

for (const binary of ["node", "bun"])
  test(
    `P4-1: daemon shutdown flushes and parses a never-exiting ${binary} server`,
    () =>
      withProfiles(async ({ root, runtime }) => {
        const script = join(root, "server.js");
        await writeFile(script, `${cpuWork} setInterval(()=>{},1000);`);
        const profiles = await runtime.runPromise(Profiles);

        const original = await runtime.runPromise(
          profiles.capture(TEST_SESSION, [binary, script], 0.01)
        );

        await Bun.sleep(600);
        await runtime.dispose();
        expect(isRunning(original.pid)).toBe(false);
        const { realpath, readFile } = await import("node:fs/promises");

        const directory = await profileDirectory(
          join(root, "profiles"),
          await realpath(root),
          original.id
        );

        expect(
          Schema.decodeUnknownSync(Schema.fromJsonString(Profile))(
            await readFile(join(directory, "profile.json"), "utf8")
          ).status
        ).toBe("completed");

        const reply = await profileJob({
          root: join(root, "profiles"),
          checkout: await realpath(root),
          operation: "get",
          id: original.id,
          active: [],
          now: Date.now(),
          maxBytes: 200 * 1024 * 1024,
          maxAgeMs: 7 * 86400_000,
        });

        expect("hotFunctions" in reply && reply.profile.status).toBe("completed");
        expect(
          "hotFunctions" in reply && reply.hotFunctions.some((f) => f.name === "polarisBurn")
        ).toBe(true);
      }),
    30000
  );

test("P4-7: restart reserves the live slot while the old artifact is being parsed", async () => {
  let hold = true;
  let reached = false;
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const worker: typeof profileJob = async (job, changed) => {
    if (hold && job.operation === "complete") {
      reached = true;
      await gate;
    }

    return profileJob(job, changed);
  };

  await withProfiles(
    async ({ root, runtime }) => {
      const script = join(root, "server.js");
      await writeFile(script, "setInterval(()=>{},1000);");
      const profiles = await runtime.runPromise(Profiles);
      const originals = [];

      for (let i = 0; i < 4; i++)
        originals.push(
          await runtime.runPromise(profiles.capture(TEST_SESSION, ["node", script], 0.01))
        );
      await Bun.sleep(300);
      const restart = runtime.runPromise(profiles.restart(TEST_SESSION, originals[0]!.pid));

      const flag = join(root, "contender-started");
      const contenderScript = join(root, "contender.js");
      await writeFile(
        contenderScript,
        `require("fs").writeFileSync(${JSON.stringify(flag)}, ""); setInterval(()=>{},1000);`
      );
      let settled = false;
      let contender: Promise<string>;

      try {
        await until(() => reached);
        contender = runtime
          .runPromise(
            profiles.capture(TEST_SESSION, ["node", contenderScript], 0.01).pipe(
              Effect.match({
                onFailure: (error) => error.message,
                onSuccess: (profile) => profile.status,
              })
            )
          )
          .finally(() => {
            settled = true;
          });
        await until(() => settled || existsSync(flag));
      } finally {
        hold = false;
        release();
      }

      const [refusal, next] = await Promise.all([contender!, restart]);
      expect(refusal).toContain("four active recordings");
      expect(next.status).toBe("recording");
      expect(isRunning(next.pid)).toBe(true);
      expect(next.pid).not.toBe(originals[0]!.pid);
    },
    { worker }
  );
}, 30000);

test("P4-4: parsing a finished command does not consume a live recording slot", async () => {
  let hold = true;
  let reached = false;
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const worker: typeof profileJob = async (job, changed) => {
    if (hold && job.operation === "complete") {
      reached = true;
      await gate;
    }

    return profileJob(job, changed);
  };

  await withProfiles(
    async ({ root, runtime }) => {
      const script = join(root, "server.js");
      await writeFile(script, "setInterval(()=>{},1000);");
      const profiles = await runtime.runPromise(Profiles);

      for (let i = 0; i < 3; i++)
        await runtime.runPromise(profiles.capture(TEST_SESSION, ["node", script], 0.01));
      await runtime.runPromise(profiles.capture(TEST_SESSION, ["node", "-e", "0"], 0.01));
      await until(() => reached);
      const admitted = runtime.runPromise(profiles.capture(TEST_SESSION, ["node", script], 0.01));

      try {
        await Bun.sleep(50);
      } finally {
        hold = false;
        release();
      }

      expect((await admitted).status).toBe("recording");
    },
    { worker }
  );
}, 30000);

test("P4-2: shutdown drains an exited child's completion waiting for queue space", async () => {
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
      const flag = join(root, "exit");
      const script = join(root, "waits.js");
      await writeFile(
        script,
        `${cpuWork} const fs=require("fs"); const t=setInterval(()=>{ if(fs.existsSync(${JSON.stringify(flag)})) clearInterval(t) },20);`
      );
      const profiles = await runtime.runPromise(Profiles);

      const original = await runtime.runPromise(
        profiles.capture(TEST_SESSION, ["node", script], 0.01)
      );

      hold = true;
      let refusals = 0;

      const reads = Array.from({ length: 33 }, () =>
        runtime.runPromise(profiles.list(TEST_SESSION)).catch(() => {
          refusals++;

          return [];
        })
      );

      let shutdown: Promise<void> | undefined;

      try {
        await until(() => refusals > 0);
        await writeFile(flag, "");
        await until(() => !isRunning(original.pid));
        await Bun.sleep(100);
        shutdown = runtime.dispose();
        await Bun.sleep(100);
      } finally {
        release();
      }

      await Promise.all(reads);
      await shutdown;

      const directory = await profileDirectory(
        join(root, "profiles"),
        await realpath(root),
        original.id
      );

      const saved = Schema.decodeUnknownSync(Schema.fromJsonString(Profile))(
        await readFile(join(directory, "profile.json"), "utf8")
      );

      expect(saved.status).toBe("completed");
      expect(existsSync(join(directory, "detail.json"))).toBe(true);
    },
    { worker }
  );
}, 30000);

// Windows cooperative exit must keep the Job Object's descendant cleanup after its parent exits.
for (const binary of ["node", "bun"])
  test.skipIf(process.platform !== "win32")(
    `cooperative ${binary} profile shutdown retires detached descendants`,
    () =>
      withProfiles(async ({ root, runtime }) => {
        const script = join(root, "parent.cjs");
        const pidFile = join(root, "descendant.json");
        await writeFile(
          script,
          `
const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify(child.pid));
setInterval(()=>{},1000);
`
        );

        const profiles = await runtime.runPromise(Profiles);

        const original = await runtime.runPromise(
          profiles.capture(TEST_SESSION, [binary, script], 0.01)
        );

        let descendant: number | undefined;

        try {
          await until(() => Bun.file(pidFile).exists());
          descendant = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Int))(
            await readFile(pidFile, "utf8")
          );
          expect(isRunning(descendant)).toBe(true);
          await runtime.dispose();
          expect(isRunning(original.pid)).toBe(false);
          await until(() => !isRunning(descendant!), 5000);
          expect(isRunning(descendant)).toBe(false);

          const directory = await profileDirectory(
            join(root, "profiles"),
            await realpath(root),
            original.id
          );

          expect(
            Schema.decodeUnknownSync(Schema.fromJsonString(Profile))(
              await readFile(join(directory, "profile.json"), "utf8")
            ).status
          ).toBe("completed");
        } finally {
          if (descendant !== undefined && isRunning(descendant))
            await killTree(descendant, "SIGKILL");
        }
      }),
    30000
  );
