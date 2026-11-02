import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";
/**
 * `install` against the real launchd, with a temp home and its own label, never
 * `dev.lux.polaris`. macOS only, opt in: POLARIS_LAUNCHD_E2E=1 bun test launchd.e2e
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { CommandRunner } from "./CommandRunner.ts";
import { type InstallContext, install, layout, uninstall } from "./install.ts";

const enabled = process.platform === "darwin" && process.env.POLARIS_LAUNCHD_E2E === "1";

const label = `dev.lux.polaris.e2e-${process.pid}`;

let root = "";

const ctx = (path: string): InstallContext => ({
  os: "darwin",
  polarisHome: join(root, ".polaris"),
  userHome: root,
  xdgConfigHome: null,
  uid: userInfo().uid,
  user: userInfo().username,
  path,
  launchdLabel: label,
});

/** A stand-in Daemon that logs its version and takes 2 s to stop, like a real shutdown. */
const fakeDaemon = (version: string) => {
  const source = join(root, `polaris-${version}`);

  writeFileSync(
    source,
    `#!/bin/sh\necho "$$ ${version}" >> "$POLARIS_HOME/ran"\ntrap 'sleep 2; exit 0' TERM\nwhile :; do sleep 0.2; done\n`
  );

  return source;
};

const runs = () => {
  try {
    return readFileSync(join(root, ".polaris", "ran"), "utf8")
      .trim()
      .split("\n");
  } catch {
    return [];
  }
};

const until = async (what: string, check: () => boolean, ms = 15_000) => {
  const deadline = Date.now() + ms;

  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
};

const launchctl = (...args: Array<string>) => Bun.spawnSync(["launchctl", ...args]).exitCode;

const loadedIn = (domain: "gui" | "user") =>
  launchctl("print", `${domain}/${userInfo().uid}/${label}`) === 0;

/** The real runner, except that the first bootstrap fails as a broken definition would. */
const failFirstBootstrap = () => {
  let failed = false;

  return Layer.effect(
    CommandRunner,
    Effect.gen(function* () {
      const real = yield* CommandRunner;

      return CommandRunner.of({
        run: (argv, options) => {
          if (argv[1] !== "bootstrap" || failed) return real.run(argv, options);
          failed = true;

          return Effect.succeed({ code: 1, stdout: "", stderr: "Bootstrap failed: 1: injected" });
        },
      });
    })
  ).pipe(Layer.provide(CommandRunner.layer));
};

const installation = (path: string, version: string, layer = CommandRunner.layer) =>
  install(ctx(path), { source: fakeDaemon(version), version }).pipe(Effect.provide(layer));

describe.skipIf(!enabled)("install against the real launchd", () => {
  beforeAll(() => {
    root = newTempDir("polaris-launchd-");
  });

  afterAll(async () => {
    await Effect.runPromise(
      uninstall(ctx("/usr/bin:/bin"), { purge: true }).pipe(Effect.provide(CommandRunner.layer))
    );
    removeTempDir(root);
  });

  test("loads into gui/<uid>", async () => {
    const first = await Effect.runPromise(installation("/usr/bin:/bin", "1.0.0"));

    expect(first.serviceDomain).toBe(`gui/${userInfo().uid}`);
    await until("1.0.0 to run", () => runs().some((line) => line.endsWith(" 1.0.0")));
  });

  test("a new build and definition over the loaded service reloads it in gui/<uid>", async () => {
    const second = await Effect.runPromise(installation("/usr/bin:/bin:/usr/sbin", "2.0.0"));

    expect(second.serviceFileChanged).toBe(true);
    expect(second.serviceDomain).toBe(`gui/${userInfo().uid}`);
    expect(second.notes).toEqual([]);

    await until("2.0.0 to run", () => runs().some((line) => line.endsWith(" 2.0.0")));
    expect(loadedIn("gui")).toBe(true);
    expect(loadedIn("user")).toBe(false);
  }, 60_000);

  test("a definition that won't load rolls back to the previous build, running", async () => {
    const before = runs().length;

    const failure = await Effect.runPromise(
      Effect.flip(installation("/usr/bin:/bin", "3.0.0", failFirstBootstrap()))
    );

    expect(failure.message).toContain("injected");
    expect(failure.message).toContain(`runs again in gui/${userInfo().uid}`);

    expect(readlinkSync(layout(ctx("/usr/bin:/bin")).current)).toBe("2.0.0");
    expect(readFileSync(layout(ctx("/usr/bin:/bin")).serviceFile, "utf8")).toContain("/usr/sbin");
    await until("2.0.0 to run again", () =>
      runs()
        .slice(before)
        .some((line) => line.endsWith(" 2.0.0"))
    );
    expect(loadedIn("gui")).toBe(true);
    expect(runs().some((line) => line.endsWith(" 3.0.0"))).toBe(false);
  }, 60_000);
});
