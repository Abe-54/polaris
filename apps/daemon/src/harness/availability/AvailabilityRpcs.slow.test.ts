import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_CATALOGUE } from "@polaris/protocol";
import { Deferred, Effect, Fiber, type Scope, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { Availability } from "./Availability.ts";
import { AvailabilityRpcs, AvailabilityRpcsLive } from "./AvailabilityRpcs.ts";
import { shellFake, shPath } from "../testing/shellFake.ts";

const dirs: Array<string> = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A Host with a fake `codex` whose sign-in the test flips; `claude` isn't installed. */
const fakeHost = () => {
  const root = mkdtempSync(join(tmpdir(), "polaris-availability-rpc-"));
  dirs.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const counter = join(root, "probes");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(bin);
  const signedIn = join(root, "signed-in");
  const slow = join(root, "slow");

  shellFake(
    bin,
    "codex",
    `if [ "$1" = "--version" ]; then [ -e "${shPath(slow)}" ] && /bin/sleep 0.5; echo x >> "${shPath(counter)}"; echo 'codex-cli 0.158.0'; exit 0; fi
if [ -e "${shPath(signedIn)}" ]; then exit 0; fi
echo 'Not logged in' >&2; exit 1`
  );

  return {
    env: { HOME: home, PATH: bin },
    signIn: () => writeFileSync(signedIn, ""),
    /** Makes each probe take half a second, so a caller can leave mid-probe. */
    slowDown: () => writeFileSync(slow, ""),
    probes: async () =>
      (await Bun.file(counter).exists()) ? (await Bun.file(counter).text()).length / 2 : 0,
  };
};

const statuses = (report: { harnesses: ReadonlyArray<{ harness: string; status: string }> }) =>
  Object.fromEntries(report.harnesses.map((h) => [h.harness, h.status]));

/** Runs `body` against the handlers, on a Host with `env`. */
const run = <A, E>(
  env: Record<string, string>,
  body: Effect.Effect<A, E, Scope.Scope | Availability>
) =>
  Effect.runPromise(
    Effect.scoped(body).pipe(Effect.provide(Availability.layer({ env, bench: false })))
  );

const client = RpcTest.makeClient(AvailabilityRpcs).pipe(Effect.provide(AvailabilityRpcsLive));

describe("harness.availability", () => {
  test("probes once, answers from the cache, probes again on refresh", async () => {
    const host = fakeHost();

    const [first, second, refreshed] = await run(
      host.env,
      Effect.gen(function* () {
        const rpc = yield* client;
        const first = yield* rpc["harness.availability"]({ refresh: false });
        const second = yield* rpc["harness.availability"]({ refresh: false });
        host.signIn();
        const refreshed = yield* rpc["harness.availability"]({ refresh: true });

        return [first, second, refreshed] as const;
      })
    );

    expect(first.harnesses.map((h) => h.harness)).toEqual(HARNESS_CATALOGUE.map((h) => h.kind));
    expect(statuses(first)).toEqual({
      claude: "not-installed",
      codex: "needs-sign-in",
      opencode: "not-installed",
      gemini: "not-installed",
      copilot: "not-installed",
    });
    expect(second).toEqual(first);
    expect(statuses(refreshed)).toEqual({
      claude: "not-installed",
      codex: "ready",
      opencode: "not-installed",
      gemini: "not-installed",
      copilot: "not-installed",
    });
    expect(await host.probes()).toBe(2);
  });

  test("concurrent asks share one probe", async () => {
    const host = fakeHost();

    await run(
      host.env,
      Effect.flatMap(client, (rpc) =>
        Effect.all(
          Array.from({ length: 5 }, () => rpc["harness.availability"]({ refresh: false })),
          { concurrency: "unbounded" }
        )
      )
    );

    expect(await host.probes()).toBe(1);
  });

  test("watch sends the current report, then each refresh", async () => {
    const host = fakeHost();

    const reports = await run(
      host.env,
      Effect.gen(function* () {
        const rpc = yield* client;
        const first = yield* Deferred.make<void>();

        const watching = yield* rpc["harness.watchAvailability"]({}).pipe(
          Stream.tap(() => Deferred.succeed(first, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild
        );

        yield* Deferred.await(first);
        host.signIn();
        yield* rpc["harness.availability"]({ refresh: true });

        return yield* Fiber.join(watching);
      })
    );

    expect(reports.map((r) => statuses(r).codex)).toEqual(["needs-sign-in", "ready"]);
  });

  test("the bench Daemon reports Claude Code and Codex ready; the others are probed", async () => {
    const host = fakeHost();
    shellFake(host.env.PATH, "gemini", "echo 0.61.0");

    const report = await Effect.runPromise(
      Effect.flatMap(Availability, (availability) => availability.get(false)).pipe(
        Effect.provide(Availability.layer({ env: host.env, bench: true }))
      )
    );

    expect(statuses(report)).toEqual({
      claude: "ready",
      codex: "ready",
      opencode: "not-installed",
      gemini: "needs-sign-in",
      copilot: "not-installed",
    });
    expect(report.harnesses.find((h) => h.harness === "gemini")?.version).toBe("0.61.0");
    expect(report.harnesses.find((h) => h.harness === "codex")?.version).toBe("bench");
    // The fake codex on PATH was never run: the bench stands in for it.
    expect(await host.probes()).toBe(0);
  });

  test("a caller interrupted mid-probe doesn't stop it, and nothing is poisoned", async () => {
    const host = fakeHost();
    host.slowDown();

    const [report, probes] = await run(
      host.env,
      Effect.gen(function* () {
        const availability = yield* Availability;
        // What the RPC server does when the first asker's Client goes away mid-probe.
        const first = yield* Effect.forkChild(availability.get(false));
        yield* Effect.sleep("100 millis");
        yield* Fiber.interrupt(first);
        const report = yield* availability.get(false);

        return [report, yield* Effect.promise(() => host.probes())] as const;
      })
    );

    expect(statuses(report)).toMatchObject({ codex: "needs-sign-in" });
    expect(probes).toBe(1);
  });

  test("a watcher unsubscribing mid-probe leaves availability working for the next one", async () => {
    const host = fakeHost();
    host.slowDown();

    const [watched, asked] = await run(
      host.env,
      Effect.gen(function* () {
        const availability = yield* Availability;
        const watching = yield* Effect.forkChild(Stream.runDrain(availability.changes));
        yield* Effect.sleep("100 millis");
        yield* Fiber.interrupt(watching);
        const watched = yield* availability.changes.pipe(Stream.take(1), Stream.runCollect);
        const rpc = yield* client;

        return [watched, yield* rpc["harness.availability"]({ refresh: false })] as const;
      })
    );

    expect(statuses(watched[0]!)).toMatchObject({ codex: "needs-sign-in" });
    expect(statuses(asked)).toMatchObject({ codex: "needs-sign-in" });
  });

  test("a refresh during a probe waits for a probe that starts after it", async () => {
    const host = fakeHost();
    host.slowDown();

    const refreshed = await run(
      host.env,
      Effect.gen(function* () {
        const rpc = yield* client;
        const first = yield* Effect.forkChild(rpc["harness.availability"]({ refresh: false }));
        yield* Effect.sleep("100 millis");
        host.signIn();
        const refreshed = yield* rpc["harness.availability"]({ refresh: true });
        yield* Fiber.join(first);

        return refreshed;
      })
    );

    expect(statuses(refreshed)).toMatchObject({ codex: "ready" });
  });
});
