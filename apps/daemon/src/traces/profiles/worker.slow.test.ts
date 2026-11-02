import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";
import { expect, test } from "bun:test";
import { writeFile, readdir, stat, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { Profile, ProfileError, ProfileId, Timestamp } from "@polaris/protocol";
import { Schema } from "effect";
import { profileDirectory, profileJob } from "./workerClient.ts";
import { sampled } from "./parser.testing.ts";
import type { ProfileJob } from "./workerProtocol.ts";

const withWorker = async (
  run: (f: {
    root: string;
    job: (
      operation: ProfileJob["operation"],
      id?: string,
      profile?: Profile,
      patch?: Partial<ProfileJob>
    ) => ReturnType<typeof profileJob>;
    profile: Profile;
    directory: string;
  }) => Promise<void>
) => {
  const root = newTempDir("p4-worker-", { short: true });
  const id = ProfileId.make(crypto.randomUUID());

  const profile = Profile.make({
    id,
    command: "bun test",
    runtime: "bun",
    pid: 123,
    turn: null,
    startedAt: Timestamp.make(new Date().toISOString()),
    durationMs: 0,
    path: null,
    status: "recording",
    origin: "command",
  });

  const directory = await profileDirectory(root, "/checkout", id);

  const job = (
    operation: ProfileJob["operation"],
    selected: string = id,
    p?: Profile,
    patch: Partial<ProfileJob> = {}
  ) =>
    profileJob({
      root,
      checkout: "/checkout",
      active: [],
      maxBytes: 200 * 1024 * 1024,
      maxAgeMs: 7 * 86400_000,
      now: Date.now(),
      operation,
      id: selected,
      ...(p === undefined ? undefined : { profile: p }),
      ...patch,
    });

  try {
    await run({ root, job, profile, directory });
  } finally {
    await removeTempDirSettled(root);
  }
};

test("retention removes aged artifacts and their parsed details, and enforces per-checkout disk budgets", () =>
  withWorker(async ({ job, profile, directory }) => {
    await job("start", profile.id, profile);
    await writeFile(join(directory, "cpu.cpuprofile"), JSON.stringify(sampled()));
    await job("complete");
    expect((await readdir(directory)).sort()).toEqual([
      "cpu.cpuprofile",
      "detail.json",
      "profile.json",
    ]);
    const result = await job("list", profile.id, undefined, { now: Date.now() + 8 * 86400_000 });
    expect(result).toEqual({ profiles: [] });
    expect(await stat(directory).catch(() => null)).toBe(null);
    await job("start", profile.id, profile);
    await job("list", profile.id, undefined, { maxBytes: 1 });
    expect(await stat(directory).catch(() => null)).toBe(null);
  }));

for (const { kind, create } of [
  { kind: "symlink", create: (from: string, to: string) => symlink(from, to) },
  { kind: "hardlink", create: (from: string, to: string) => link(from, to) },
])
  test(`raw ${kind}s are refused without changing their target`, () =>
    withWorker(async ({ root, job, profile, directory }) => {
      await job("start", profile.id, profile);
      const target = join(root, "external.json");
      await writeFile(target, JSON.stringify(sampled()), { mode: 0o644 });
      const originalMode = (await stat(target)).mode;
      await create(target, join(directory, "cpu.cpuprofile"));
      const result = await job("complete");
      expect("profile" in result && result.profile.status).toBe("failed");
      expect((await stat(target)).mode).toBe(originalMode);
      expect(await readdir(directory)).toEqual(["profile.json"]);
    }));

test(
  "50 MB CPU profiles are parsed and persisted in a worker while the Daemon event loop remains responsive",
  () =>
    withWorker(async ({ job, profile, directory }) => {
      await job("start", profile.id, profile);

      const cpu = {
        ...sampled(),
        endTime: 1000 + 1_000_000,
        samples: Array(1_000_000).fill(4),
        timeDeltas: Array(1_000_000).fill(1),
      };

      const raw = JSON.stringify(cpu);
      const bytes = 50_000_000;
      await writeFile(
        join(directory, "cpu.cpuprofile"),
        raw + " ".repeat(bytes - Buffer.byteLength(raw))
      );
      let last = performance.now();
      let maxGap = 0;
      let ticks = 0;

      const timer = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
        ticks++;
      }, 10);

      const started = performance.now();

      try {
        const result = await job("complete");
        expect("profile" in result && result.profile.status).toBe("completed");
        expect(ticks).toBeGreaterThan(5);
        console.log(
          JSON.stringify({
            bytes,
            elapsedMs: performance.now() - started,
            eventLoopMaxGapMs: maxGap,
            ticks,
          })
        );
      } finally {
        clearInterval(timer);
      }
    }),
  60000
);

test("filesystem failures return a storage error with an actionable permissions fix", () =>
  withWorker(async ({ root, job, profile }) => {
    const path = join(root, "not-a-directory");
    await writeFile(path, "file");

    const error = await job("list", profile.id, undefined, { root: path }).then(
      () => null,
      Schema.decodeUnknownSync(ProfileError)
    );

    expect(error?.code).toBe("E-PROFILE-UNAVAILABLE");
    expect(error?.fix).toContain("permissions");
  }));

for (const operation of ["get", "list"] as const)
  test(`P4-2: ${operation} recovers an orphan recording with a flushed artifact`, () =>
    withWorker(async ({ job, profile, directory }) => {
      await job("start", profile.id, profile);
      await writeFile(join(directory, "cpu.cpuprofile"), JSON.stringify(sampled()));
      const reply = await job(operation);
      expect(
        "profiles" in reply ? reply.profiles[0]!.status : "profile" in reply && reply.profile.status
      ).toBe("completed");
      const detail = await job("get");
      expect(
        "hotFunctions" in detail && detail.hotFunctions.find((f) => f.name === "leaf")?.selfMs
      ).toBe(5);
    }));
