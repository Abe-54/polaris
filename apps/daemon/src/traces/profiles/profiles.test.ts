import { expect, test } from "bun:test";
import {
  readFile,
  stat,
  writeFile,
  realpath,
  mkdir,
  rename,
  symlink,
  unlink,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { Effect, Stream, Schema, Fiber } from "effect";
import { ProfileError, ProfileId, DomainEvent } from "@polaris/protocol";
import { TEST_SESSION } from "../testing.ts";
import { Profiles } from "./index.ts";
import { cpuWork, withProfiles } from "./testing.ts";
import { isRunning } from "../../platform/processes.ts";
import { profileJob } from "./workerClient.ts";
import { sampled } from "./parser.testing.ts";
import { commit, turn } from "../authority.testing.ts";

for (const binary of ["node", "bun"])
  test(
    `captures real ${binary} CPU work through runtime options and parses self, total and chronological frames`,
    () =>
      withProfiles(async ({ root, runtime }) => {
        await runtime.runPromise(commit([DomainEvent.cases.TurnStarted.make({ turn: turn(0) })]));
        const script = join(root, "target.js");
        await writeFile(script, cpuWork);
        const before = Date.now();

        const result = await runtime.runPromise(
          Effect.gen(function* () {
            const profiles = yield* Profiles;
            const profile = yield* profiles.capture(TEST_SESSION, [binary, script]);
            const detail = yield* profiles.get(TEST_SESSION, profile.id);

            return { profile, detail, list: yield* profiles.list(TEST_SESSION) };
          })
        );

        const { profile, detail } = result;
        expect(profile.status).toBe("completed");
        expect(profile.origin).toBe("command");
        expect(profile.turn?.number).toBe(1);
        expect(profile.turn?.sessionId).toBe(TEST_SESSION);
        expect(Date.parse(profile.startedAt)).toBeGreaterThanOrEqual(before);
        expect(profile.durationMs).toBeGreaterThan(80);
        expect(profile.durationMs).toBeLessThanOrEqual(Date.now() - before);
        expect(profile.path!.startsWith(join(root, "profiles"))).toBe(true);
        expect(
          Schema.decodeUnknownSync(
            Schema.fromJsonString(Schema.Struct({ samples: Schema.Array(Schema.Number) }))
          )(await readFile(profile.path!, "utf8")).samples.length
        ).toBeGreaterThan(0);

        if (process.platform !== "win32")
          expect((await stat(profile.path!)).mode & 0o777).toBe(0o600);
        const hot = detail.hotFunctions.find((f) => f.name === "polarisBurn")!;
        expect(hot.selfMs).toBeGreaterThan(0);
        expect(hot.totalMs).toBeGreaterThanOrEqual(hot.selfMs);
        expect(hot.file).toBe("target.js");
        expect(hot.line).toBe(1);
        expect(detail.hotPath.length).toBeGreaterThan(0);

        for (const [i, node] of detail.nodes.entries()) {
          expect(node.functionIndex).toBeLessThan(detail.hotFunctions.length);

          if (node.parent !== null) expect(node.parent).toBeLessThan(i);
          expect(node.startMs + node.durationMs).toBeLessThanOrEqual(profile.durationMs + 0.001);
        }

        expect(result.list.map((p) => p.id)).toContain(profile.id);
      }),
    30000
  );

test(
  "restart owns live handles, publishes recording and completed snapshots, and refuses foreign, gone and user PIDs",
  () =>
    withProfiles(async ({ root, runtime, addSession }) => {
      const script = join(root, "server.js");
      await writeFile(script, `${cpuWork} setTimeout(()=>{},1800);`);
      const profiles = await runtime.runPromise(Profiles);

      const original = await runtime.runPromise(
        profiles.capture(TEST_SESSION, ["node", script], 0.01)
      );

      expect(original.status).toBe("recording");
      const foreign = await addSession("foreign", { checkout: join(root, "other") });
      expect(
        (await runtime.runPromise(profiles.restart(foreign, original.pid).pipe(Effect.flip))).code
      ).toBe("E-PROFILE-PROCESS-NOT-OWNED");

      const notOwned = await runtime.runPromise(
        profiles.restart(foreign, process.pid).pipe(Effect.flip)
      );

      expect(notOwned.code).toBe("E-PROFILE-PROCESS-NOT-OWNED");
      expect(notOwned.message).toBe("Polaris didn't start this process");
      expect(notOwned.fix).toContain("Ask the user");
      const next = await runtime.runPromise(profiles.restart(TEST_SESSION, original.pid));
      expect(next.pid).not.toBe(original.pid);
      expect(next.origin).toBe("restart");
      expect(next.status).toBe("recording");

      const snapshots = await runtime.runPromise(
        profiles.watch(TEST_SESSION).pipe(
          Stream.takeUntil((s) =>
            s.profiles.some((p) => p.id === next.id && p.status === "completed")
          ),
          Stream.runCollect,
          Effect.timeout(10000)
        )
      );

      expect(snapshots[0]!.profiles.find((p) => p.id === next.id)!.status).toBe("recording");
      expect(snapshots.at(-1)!.profiles.find((p) => p.id === next.id)!.status).toBe("completed");
      expect(
        (await runtime.runPromise(profiles.restart(TEST_SESSION, original.pid).pipe(Effect.flip)))
          .code
      ).toBe("E-PROFILE-PROCESS-NOT-OWNED");
    }),
  30000
);

test(
  "untrusted, plan, reviewer and policy-read-only sessions cannot execute or restart but can read retained profiles",
  () =>
    withProfiles(async ({ runtime, trust, readonly, addSession }) => {
      const profiles = await runtime.runPromise(Profiles);

      const profile = await runtime.runPromise(
        profiles.capture(TEST_SESSION, ["bun", "-e", cpuWork])
      );

      const plan = await addSession("plan", { mode: "plan" });
      const reviewer = await addSession("reviewer", { mode: "auto", origin: "reviewer" });

      const check = async (id: typeof TEST_SESSION, phrase: string) => {
        for (const run of [
          profiles.capture(id, ["bun", "-e", cpuWork]),
          profiles.restart(id, process.pid),
        ]) {
          const result = await runtime.runPromise(run.pipe(Effect.flip));
          expect(result).toBeInstanceOf(ProfileError);
          expect(result.message).toContain(phrase);
        }

        expect((await runtime.runPromise(profiles.get(id, profile.id))).profile.id).toBe(
          profile.id
        );
      };

      await check(plan, "read-only");
      await check(reviewer, "read-only");
      readonly(true);
      await check(TEST_SESSION, "read-only");
      readonly(false);
      trust(false);
      await check(TEST_SESSION, "not trusted");
    }),
  30000
);

test(
  "profile ids and artifact paths never authorize another checkout or arbitrary file read",
  () =>
    withProfiles(async ({ runtime }) => {
      const profiles = await runtime.runPromise(Profiles);

      const error = await runtime.runPromise(
        profiles.get(TEST_SESSION, ProfileId.make("../../etc/passwd")).pipe(Effect.flip)
      );

      expect(error.code).toBe("E-PROFILE-NOT-FOUND");
    }),
  30000
);

test(
  "a failed scoped attach recording removes its directory and never grants restart authority",
  () =>
    withProfiles(async ({ runtime }) => {
      const profiles = await runtime.runPromise(Profiles);
      let directory = "";

      const result = await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const recording = yield* profiles.record(TEST_SESSION, {
              command: "node attached",
              runtime: "node",
              pid: process.pid,
            });

            directory = recording.directory;
            yield* Effect.promise(() =>
              writeFile(join(directory, "partial.cpuprofile"), "incomplete")
            );

            return yield* Effect.fail("attach cancelled");
          })
        ).pipe(Effect.flip)
      );

      expect(result).toBe("attach cancelled");
      expect(await stat(directory).catch(() => null)).toBe(null);
      expect(await runtime.runPromise(profiles.list(TEST_SESSION))).toEqual([]);
      expect(
        (await runtime.runPromise(profiles.restart(TEST_SESSION, process.pid).pipe(Effect.flip)))
          .code
      ).toBe("E-PROFILE-PROCESS-NOT-OWNED");
    }),
  30000
);

test(
  "scoped attach storage finalises once and serves the retained function table without owning the target PID",
  () =>
    withProfiles(async ({ runtime }) => {
      const profiles = await runtime.runPromise(Profiles);

      const profile = await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const recording = yield* profiles.record(TEST_SESSION, {
              command: "attached Node",
              runtime: "node",
              pid: process.pid,
              service: "fixture-api",
            });

            yield* Effect.promise(() =>
              writeFile(join(recording.directory, "cpu.cpuprofile"), JSON.stringify(sampled()))
            );
            yield* recording.finish;

            return yield* recording.finish;
          })
        )
      );

      const detail = await runtime.runPromise(profiles.get(TEST_SESSION, profile.id));
      expect(detail.profile.status).toBe("completed");
      expect(detail.profile.origin).toBe("attach");
      expect(detail.profile.service).toBe("fixture-api");
      expect(detail.hotFunctions.find((f) => f.name === "leaf")?.selfMs).toBe(5);
      expect(
        (await runtime.runPromise(profiles.restart(TEST_SESSION, process.pid).pipe(Effect.flip)))
          .code
      ).toBe("E-PROFILE-PROCESS-NOT-OWNED");
    }),
  30000
);

test(
  "interrupting a scoped recording discards its partial artifact before the fiber exits",
  () =>
    withProfiles(async ({ runtime }) => {
      const profiles = await runtime.runPromise(Profiles);
      const ready = Promise.withResolvers<string>();

      const fiber = Effect.runFork(
        Effect.scoped(
          Effect.gen(function* () {
            const recording = yield* profiles.record(TEST_SESSION, {
              command: "interrupted attach",
              runtime: "node",
              pid: process.pid,
            });

            yield* Effect.sync(() => ready.resolve(recording.directory));
            yield* Effect.never;
          })
        ).pipe(Effect.catch((error) => Effect.sync(() => ready.reject(error))))
      );

      const directory = await ready.promise;
      await writeFile(join(directory, "partial.cpuprofile"), "partial");
      await Effect.runPromise(Fiber.interrupt(fiber));
      expect(await stat(directory).catch(() => null)).toBe(null);
      expect(await runtime.runPromise(profiles.list(TEST_SESSION))).toEqual([]);
    }),
  30000
);

test("shutdown stops a spawned command while its metadata is still awaiting the worker", async () => {
  const started = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  await withProfiles(
    async ({ runtime }) => {
      const profiles = await runtime.runPromise(Profiles);

      const capturing = runtime
        .runPromise(profiles.capture(TEST_SESSION, ["node", "-e", "setInterval(()=>{},1000)"]))
        .catch(() => null);

      const pid = await started.promise;
      const closing = runtime.dispose();

      try {
        const deadline = Date.now() + 1000;

        while (isRunning(pid) && Date.now() < deadline) await Bun.sleep(10);
        expect(isRunning(pid)).toBe(false);
      } finally {
        release.resolve();
        await closing;
        await capturing;
      }
    },
    {
      worker: async (job, changed) => {
        if (job.operation === "start" && job.profile !== undefined) {
          started.resolve(job.profile.pid);
          await release.promise;
        }

        return profileJob(job, changed);
      },
    }
  );
}, 30000);

test(
  "capture preserves explicit upstream tracing, prior Bun options and the known service name",
  () =>
    withProfiles(async ({ root, runtime }) => {
      const previous = {
        options: process.env.BUN_OPTIONS,
        endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
        service: process.env.OTEL_SERVICE_NAME,
      };

      const endpoint = "http://127.0.0.1:54321/upstream";

      try {
        process.env.BUN_OPTIONS = "--smol";
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
        process.env.OTEL_SERVICE_NAME = "profile-fixture";
        const script = join(root, "environment.js");
        const recorded = join(root, "environment.json");
        await writeFile(
          script,
          `${cpuWork} require("node:fs").writeFileSync(${JSON.stringify(recorded)},JSON.stringify({options:process.env.BUN_OPTIONS,endpoint:process.env.OTEL_EXPORTER_OTLP_ENDPOINT,service:process.env.OTEL_SERVICE_NAME}));`
        );
        const profiles = await runtime.runPromise(Profiles);
        const profile = await runtime.runPromise(profiles.capture(TEST_SESSION, ["bun", script]));

        const env = Schema.decodeUnknownSync(
          Schema.fromJsonString(
            Schema.Struct({
              options: Schema.String,
              endpoint: Schema.String,
              service: Schema.String,
            })
          )
        )(await readFile(recorded, "utf8"));

        expect(profile.status).toBe("completed");
        expect(profile.service).toBe("profile-fixture");
        expect(env.options).toContain("--smol");
        expect(env.options).toContain("--cpu-prof");
        expect(env.endpoint).toBe(endpoint);
        expect(env.service).toBe("profile-fixture");
      } finally {
        if (previous.options === undefined) delete process.env.BUN_OPTIONS;
        else process.env.BUN_OPTIONS = previous.options;

        if (previous.endpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
        else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previous.endpoint;

        if (previous.service === undefined) delete process.env.OTEL_SERVICE_NAME;
        else process.env.OTEL_SERVICE_NAME = previous.service;
      }
    }),
  30000
);

test(
  "a package-subfolder session runs relative commands there while profile locations stay checkout-relative",
  () =>
    withProfiles(async ({ root, runtime }) => {
      const directory = join(root, "package");
      await writeFile(
        join(directory, "relative.js"),
        `${cpuWork} require("node:fs").writeFileSync("relative.out",process.cwd());`
      );
      const profiles = await runtime.runPromise(Profiles);

      const profile = await runtime.runPromise(
        profiles.capture(TEST_SESSION, ["bun", "relative.js"])
      );

      const detail = await runtime.runPromise(profiles.get(TEST_SESSION, profile.id));
      const expectedCwd = await realpath(directory);
      expect(profile.cwd).toBe(expectedCwd);
      expect(await readFile(join(directory, "relative.out"), "utf8")).toBe(expectedCwd);
      expect(detail.hotFunctions.find((f) => f.name === "polarisBurn")?.file).toBe(
        "package/relative.js"
      );
    }),
  30000
);

test(
  "restart refuses an original cwd redirected outside the checkout without stopping the owned process",
  () =>
    withProfiles(async ({ root, runtime, addSession }) => {
      const directory = join(root, "package");
      const outside = `${root}-outside`;
      await mkdir(outside);
      await writeFile(join(directory, "server.js"), "setInterval(()=>{},1000)");
      const profiles = await runtime.runPromise(Profiles);
      const caller = await addSession("restart-from-root", { cwd: root });

      const profile = await runtime.runPromise(
        profiles.capture(TEST_SESSION, ["node", "server.js"], 0.01)
      );

      expect(isRunning(profile.pid)).toBe(true);

      try {
        await rename(directory, join(outside, "moved"));
        await symlink(join(outside, "moved"), directory);

        const error = await runtime.runPromise(
          profiles.restart(caller, profile.pid).pipe(Effect.flip)
        );

        expect(error.code).toBe("E-PROFILE-RESTART-REFUSED");
        expect(error.message).toContain("directory");
        expect(isRunning(profile.pid)).toBe(true);
      } finally {
        await unlink(directory).catch(() => {});
        await rename(join(outside, "moved"), directory).catch(() => {});
        await rm(outside, { recursive: true, force: true });
      }
    }),
  30000
);
