import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLocalDaemon } from "./daemon.ts";
import { scriptedInstallHome } from "./scripted.ts";

test.skipIf(process.platform === "win32")(
  "scripted LocalHost never resolves a live POSIX system Daemon, even in a dev build",
  async () => {
    const home = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "sx-"));
    const socket = join(home, ".polaris", "daemon.sock");
    mkdirSync(join(home, ".polaris"));
    const server = createServer((connection) => connection.end());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });

    try {
      const code = `
      import { Effect, Option } from "effect";
      import { LocalHost } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};
      const local = Effect.runSync(LocalHost.useSync(s => s).pipe(Effect.provide(
        LocalHost.forPlatform("darwin", {dev: true, repoRoot: "/nonexistent", env: process.env})
      )));
      const result = await Effect.runPromise(Effect.match(local.resolve, {onSuccess: () => "resolved", onFailure: error => error._tag}));
      console.log(JSON.stringify({supported: local.supported, empty: Option.isNone(Effect.runSync(local.current)), error: result}));
    `;

      const child = Bun.spawn(["bun", "--eval", code], {
        env: {
          ...process.env,
          HOME: home,
          POLARIS_HOME: join(home, ".polaris"),
          POLARIS_DESKTOP_SCRIPTED: "1",
          POLARIS_DESKTOP_DAEMON: "system",
          POLARIS_DESKTOP_LOCAL_SOCKET: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(output.trim()).toBe(
        JSON.stringify({ supported: false, empty: true, error: "LocalHostUnsupported" })
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  }
);

test("scripted native resolution refuses fallback and system paths, preserving disposable sockets", async () => {
  const home = mkdtempSync(join(tmpdir(), "sx-"));
  const options = { dev: false, repoRoot: "/nonexistent", env: { POLARIS_DESKTOP_SCRIPTED: "1" } };

  try {
    expect(await resolveLocalDaemon(options).catch(String)).toContain("no automatic local Daemon");
    expect(
      await resolveLocalDaemon({
        ...options,
        env: {
          ...options.env,
          POLARIS_DESKTOP_LOCAL_SOCKET: "/Users/example/.polaris/daemon.sock",
        },
      }).catch(String)
    ).toContain("temporary directory");

    for (const installedHome of [undefined, home]) {
      const local = await resolveLocalDaemon({
        ...options,
        env: {
          ...options.env,
          POLARIS_DESKTOP_LOCAL_SOCKET: join(home, "daemon.sock"),
          POLARIS_DESKTOP_LOCAL_HOME: installedHome,
        },
      });

      expect(local.installedHome).toBeNull();
      expect(local.socketPath).toBe(join(home, "daemon.sock"));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("local install smokes require a temporary home and CI or a disposable VM on macOS", () => {
  const home = mkdtempSync(join(tmpdir(), "sx-"));
  const optIn = { POLARIS_DESKTOP_SCRIPTED_LOCAL_INSTALL: "1" };

  try {
    expect(scriptedInstallHome(home, {}, "darwin")).toBeNull();
    expect(() => scriptedInstallHome(null, optIn, "darwin")).toThrow("temporary home");
    expect(() => scriptedInstallHome("/Users/example", { ...optIn, CI: "1" }, "darwin")).toThrow(
      "temporary home"
    );
    expect(() => scriptedInstallHome(home, optIn, "darwin")).toThrow("dev.lux.polaris launchd job");
    expect(scriptedInstallHome(home, { ...optIn, CI: "1" }, "darwin")).toBe(realpathSync(home));
    expect(
      scriptedInstallHome(home, { ...optIn, POLARIS_DESKTOP_SCRIPTED_VM: "1" }, "darwin")
    ).toBe(realpathSync(home));
    expect(scriptedInstallHome(home, optIn, "win32")).toBe(realpathSync(home));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("only the separate install opt-in exposes the disposable installed home", async () => {
  const home = mkdtempSync(join(tmpdir(), "sx-"));

  try {
    const local = await resolveLocalDaemon({
      dev: true,
      repoRoot: "/nonexistent",
      env: {
        POLARIS_DESKTOP_SCRIPTED: "1",
        POLARIS_DESKTOP_LOCAL_SOCKET: join(home, "daemon.sock"),
        POLARIS_DESKTOP_LOCAL_HOME: home,
        POLARIS_DESKTOP_SCRIPTED_LOCAL_INSTALL: "1",
        CI: "1",
      },
    });

    expect(local.installedHome).toBe(realpathSync(home));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "scripted sockets cannot escape a temporary directory through a symlink",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "sx-"));

    try {
      symlinkSync("/", join(home, "escape"));
      expect(
        await resolveLocalDaemon({
          dev: true,
          repoRoot: "/nonexistent",
          env: {
            POLARIS_DESKTOP_SCRIPTED: "1",
            POLARIS_DESKTOP_LOCAL_SOCKET: join(
              home,
              "escape",
              "Users/example/.polaris/daemon.sock"
            ),
          },
        }).catch(String)
      ).toContain("temporary directory");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
);
