import { describe, expect, test } from "bun:test";
import { type SpawnOptions, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { nodeChildProcess } from "../process/index.ts";
import { runCommand, shellQuote, Ssh, SshError } from "./Ssh.ts";

test.skipIf(process.platform === "win32")(
  "local install commands pin POLARIS_HOME to the selected home",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "sx-install-"));

    try {
      const code = `
      import { Effect } from "effect";
      import { Ssh } from ${JSON.stringify(join(import.meta.dir, "Ssh.ts"))};
      const result = await Effect.runPromise(Ssh.use(ssh => ssh.exec("local", ${JSON.stringify('printf "%s" "$POLARIS_HOME"')})).pipe(Effect.provide(Ssh.local(${JSON.stringify(home)}))));
      console.log(result.stdout);
    `;

      const child = Bun.spawn(["bun", "--eval", code], {
        env: { ...process.env, HOME: home, POLARIS_HOME: join(home, "other-daemon") },
        stdout: "pipe",
        stderr: "pipe",
      });

      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(output.trim()).toBe(join(home, ".polaris"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
);

describe("runCommand", () => {
  test("hides each install command's console window on Windows", async () => {
    const seen: Array<SpawnOptions> = [];

    // SAFETY: records the options and delegates; the overload set is wider than this call.
    const recording = ((file: string, args: ReadonlyArray<string>, options: SpawnOptions) => {
      seen.push(options);

      return spawn(file, args, options);
    }) as typeof spawn;

    const result = await Effect.runPromise(
      runCommand({
        alias: "studio",
        file: "sh",
        args: ["-c", "echo ok"],
        transportFailure: null,
        processes: nodeChildProcess(recording),
      })
    );

    expect(result.stdout.trim()).toBe("ok");
    expect(seen.map((options) => options.windowsHide)).toEqual([true]);
  });
});

test("an alias that reads as an ssh option is refused before ssh runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "polaris-ssh-alias-"));

  try {
    const ran = join(root, "ran");
    const binary = join(root, "ssh");
    writeFileSync(binary, `#!/bin/sh\ntouch ${shellQuote(ran)}\n`, { mode: 0o700 });
    const alias = "-oProxyCommand=touch /tmp/pwned";

    const error = await Effect.runPromise(
      Ssh.use((ssh) => ssh.exec(alias, "true")).pipe(
        Effect.flip,
        Effect.provide(Ssh.withOptions({ platform: "darwin", sshBinary: binary }))
      )
    );

    expect(error).toEqual(new SshError({ alias, failure: "spawn", message: "invalid alias" }));
    expect(existsSync(ran)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
