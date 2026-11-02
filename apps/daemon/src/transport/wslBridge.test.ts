/**
 * A HostConnection to a "WSL distro" end to end: the fake `wsl.exe`
 * (`@polaris/client/wsl`'s test harness) runs `~/.polaris/bin/current/polaris
 * bridge` in the distro's home, where that `polaris` is a stand-in that execs
 * the real bridge against an in-process Daemon. Nothing here touches real WSL.
 */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HostTarget, makeHostConnection } from "@polaris/client";
import { writeFakeWsl } from "@polaris/client/wsl/testing";
import { Effect, Option, Stream } from "effect";
import { startServer } from "./server.ts";
import { posixDescribe } from "../platform/testing.ts";
import { newTempDir, removeTempDirSettled } from "../platform/tempDir.testing.ts";

const BRIDGE = join(import.meta.dir, "fixtures", "bridge.ts");

const q = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const homes: Array<string> = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await removeTempDirSettled(home);
});

const identity = { name: "polaris-test", version: "0.0.0", deviceLabel: "WSL", capabilities: [] };

/** A distro home whose installed `polaris` bridges to the Daemon at `<home>/.polaris/daemon.sock`. */
const distroHome = (withPolaris: boolean) => {
  // Short path: Unix socket paths are limited to ~104 bytes on macOS.
  const home = newTempDir("pwsl-", { short: true });
  homes.push(home);
  const polaris = join(home, ".polaris");
  mkdirSync(join(polaris, "bin", "current"), { recursive: true });

  if (withPolaris) {
    const script = join(polaris, "bin", "current", "polaris");
    writeFileSync(
      script,
      `#!/bin/sh\n[ "$1" = bridge ] || exit 2\nPOLARIS_HOME=${q(polaris)} exec ${q(process.execPath)} ${q(BRIDGE)} 500\n`
    );
    chmodSync(script, 0o755);
  }

  return { home, polaris };
};

const firstStatus = (distro: string, fake: ReturnType<typeof writeFakeWsl>) =>
  Effect.gen(function* () {
    const connection = yield* makeHostConnection({
      key: `wsl:${distro}`,
      name: distro,
      target: HostTarget.Wsl({ distro }),
      identity,
      wsl: fake,
      policy: { initialDelayMs: 60_000, needsAttentionRetryMs: 60_000, helloTimeoutMs: 3_000 },
    });

    return yield* connection.changes.pipe(
      Stream.filter((status) => status.state !== "reconnecting" || status.failure !== null),
      Stream.runHead,
      Effect.map(Option.getOrNull)
    );
  }).pipe(Effect.scoped);

// Every case runs the fake wsl.exe; the distro side is Linux by definition.
posixDescribe("the fake wsl.exe and the distro's polaris are /bin/sh scripts (ENG-318)")(
  "a WSL distro as a Host",
  () => {
    test("connects through wsl.exe --exec to the Daemon inside the distro", async () => {
      const { home, polaris } = distroHome(true);

      const fake = writeFakeWsl(join(home, "wsl"), {
        distros: [{ name: "Ubuntu", version: 2, state: "Running", home }],
      });

      const status = await Effect.runPromise(
        Effect.gen(function* () {
          yield* startServer({
            socketPath: join(polaris, "daemon.sock"),
            lockPath: join(polaris, "daemon.lock"),
            root: polaris,
          });

          return yield* firstStatus("Ubuntu", fake);
        }).pipe(Effect.scoped)
      );

      expect(status?.state).toBe("connected");
    }, 20_000);

    test("no Daemon in the distro is Needs Attention, daemon-not-running", async () => {
      const { home } = distroHome(true);

      const fake = writeFakeWsl(join(home, "wsl"), {
        distros: [{ name: "Ubuntu", version: 2, state: "Running", home }],
      });

      const status = await Effect.runPromise(firstStatus("Ubuntu", fake));
      expect(status?.state).toBe("needs-attention");
      expect(status?.failure?.reason).toBe("daemon-not-running");
    }, 20_000);

    test("no polaris in the distro asks for the install flow", async () => {
      const { home } = distroHome(false);

      const fake = writeFakeWsl(join(home, "wsl"), {
        distros: [{ name: "Ubuntu", version: 2, state: "Running", home }],
      });

      const status = await Effect.runPromise(firstStatus("Ubuntu", fake));
      expect(status?.failure?.reason).toBe("polaris-not-installed");
    }, 20_000);

    test("a distro that no longer exists needs the user", async () => {
      const { home } = distroHome(true);
      const fake = writeFakeWsl(join(home, "wsl"), { distros: [] });

      const gone = await Effect.runPromise(firstStatus("Ubuntu", fake));
      expect(gone?.failure?.reason).toBe("wsl-distro-missing");
    }, 20_000);

    test("a missing wsl.exe needs the user", async () => {
      const { home } = distroHome(true);
      const fake = writeFakeWsl(join(home, "wsl"), { distros: [] });

      const missing = await Effect.runPromise(
        firstStatus("Ubuntu", { ...fake, wslBinary: join(home, "absent", "wsl.exe") })
      );

      expect(missing?.failure?.reason).toBe("wsl-missing");
    }, 20_000);
  }
);
