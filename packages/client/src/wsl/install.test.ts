/**
 * The install flow's commands inside a fake WSL distro: the real probe and
 * upload scripts run through the fake `wsl.exe` in a local `sh` with HOME at
 * the distro's directory, as `install/remote.test.ts` does over a fake ssh.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { probeHost, shScript, Ssh } from "../install/index.ts";
import { writeFakeWsl } from "./fakeWsl.testing.ts";
import { wslInstallLayer } from "./install.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "polaris-wsl-install-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const fake = () =>
  writeFakeWsl(join(dir, "wsl"), {
    distros: [{ name: "Ubuntu", version: 2, state: "Running", home: join(dir, "ubuntu") }],
  });

describe("wslInstallLayer", () => {
  test("the probe runs in the distro's home and reports this machine's uname", async () => {
    const probe = await Effect.runPromise(
      probeHost("Ubuntu").pipe(Effect.provide(wslInstallLayer(fake())))
    );

    expect(probe.os.toLowerCase()).toBe(process.platform);
    expect(probe.installed ?? null).toBeNull();
  });

  test("stdin streams a local file into the distro, byte for byte", async () => {
    const source = join(dir, "build.bin");
    const bytes = Buffer.alloc(300_000, 7);
    writeFileSync(source, bytes);
    const seen: Array<number> = [];

    const result = await Effect.runPromise(
      Ssh.use((ssh) =>
        ssh.exec(
          "Ubuntu",
          shScript(
            'cat > "$HOME/copy.bin"; sha256sum "$HOME/copy.bin" 2>/dev/null || shasum -a 256 "$HOME/copy.bin"'
          ),
          {
            stdinFile: source,
            onStdinBytes: (n) => seen.push(n),
          }
        )
      ).pipe(Effect.provide(wslInstallLayer(fake())))
    );

    expect(result.code).toBe(0);
    expect(result.stdout.split(" ")[0]).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(readFileSync(join(dir, "ubuntu", "copy.bin")).equals(bytes)).toBe(true);
    expect(seen.at(-1)).toBe(bytes.length);
  });

  test("an unknown distro is an SshError the flow shows as unreachable", async () => {
    const error = await Effect.runPromise(
      Ssh.use((ssh) => ssh.exec("Fedora", "true")).pipe(
        Effect.flip,
        Effect.provide(wslInstallLayer(fake()))
      )
    );

    expect(error.failure).toBe("unreachable");
    expect(error.message).toBe("There is no distribution with the supplied name.");
  });

  test("a command's own output naming WSL's messages is still the command's result", async () => {
    const result = await Effect.runPromise(
      Ssh.use((ssh) => ssh.exec("Ubuntu", "echo 'systemctl is not installed'; exit 3")).pipe(
        Effect.provide(wslInstallLayer(fake()))
      )
    );

    expect(result.code).toBe(3);
  });

  test("a WSL that isn't installed is a spawn failure", async () => {
    const stub = writeFakeWsl(join(dir, "wsl"), { distros: [], installed: false });

    const error = await Effect.runPromise(
      Ssh.use((ssh) => ssh.exec("Ubuntu", "true")).pipe(
        Effect.flip,
        Effect.provide(wslInstallLayer(stub))
      )
    );

    expect(error.failure).toBe("spawn");
    expect(error.message).toContain("not installed");
  });
});
