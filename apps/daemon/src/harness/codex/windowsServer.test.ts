import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { join } from "node:path";
import { isRunning, system32 } from "../../platform/processes.ts";
import { processCreated, writePrivateFile } from "../../platform/windowsNative.ts";
import { readAppServerState, stopAppServer, tokenFileOf } from "./AppServer.ts";
import { ownsListen, serverArgs } from "./windowsServer.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

const windowsOnly = test.skipIf(process.platform !== "win32");

/** Giving a file to another account takes an elevated session (`icacls /setowner`). */
const elevated =
  process.platform === "win32" && Bun.spawnSync([system32("net.exe"), "session"]).exitCode === 0;

test.skipIf(!elevated)("a state file another account owns is not trusted", () => {
  const home = newTempDir("pstate-");
  const stateFile = join(home, "codex-app-server.json");
  const state = { pid: 1, version: null, codexPath: "c", socketPath: "s", startedAt: 0 };

  try {
    writePrivateFile(stateFile, JSON.stringify(state));
    expect(readAppServerState(stateFile)).toEqual(state);
    Bun.spawnSync([system32("icacls.exe"), stateFile, "/setowner", "*S-1-5-19"]);

    expect(readAppServerState(stateFile)).toBeNull();
  } finally {
    removeTempDir(home);
  }
});

describe("a server a previous Daemon left", () => {
  /** A stand-in for its listener: a cmd.exe whose command line ends in `note`. */
  const standIn = (note: string) =>
    Bun.spawn(
      [system32("cmd.exe"), "/d", "/c", `${system32("PING.EXE")} -n 60 127.0.0.1 & rem ${note}`],
      {
        stdout: "ignore",
        stderr: "ignore",
      }
    );

  windowsOnly(
    "is ended only while its listener is that process, running app-server on this home's token",
    async () => {
      const home = newTempDir("pstale-");
      const stateFile = join(home, "codex-app-server.json");
      const token = tokenFileOf(stateFile);

      const children = {
        unrelated: standIn("something else"),
        otherHome: standIn(`app-server --ws-token-file C:\\elsewhere\\token`),
        reusedPid: standIn(`app-server --ws-token-file ${token}`),
        ours: standIn(`app-server --ws-token-file ${token}`),
      };

      try {
        await Bun.sleep(300);

        for (const [name, child] of Object.entries(children)) {
          const created = processCreated(child.pid)!;

          writePrivateFile(
            stateFile,
            JSON.stringify({
              pid: 0x7fff_fff0,
              version: null,
              codexPath: "codex.cmd",
              socketPath: join(home, "codex.sock"),
              startedAt: 0,
              sanitizedEnv: true,
              listen: "ws://127.0.0.1:1",
              listenerPid: child.pid,
              // As if the recorded server died and its pid went to this later process.
              listenerCreated: String(name === "reusedPid" ? created - 1n : created),
            })
          );
          await Effect.runPromise(stopAppServer({ stateFile }));
        }

        await Bun.sleep(500);
        expect(
          Object.fromEntries(
            Object.entries(children).map(([name, child]) => [name, isRunning(child.pid)])
          )
        ).toEqual({
          unrelated: true,
          otherHome: true,
          reusedPid: true,
          ours: false,
        });
      } finally {
        for (const child of Object.values(children)) child.kill("SIGKILL");
        removeTempDir(home);
      }
    }
  );
});

describe("the Windows app-server launch", () => {
  test("binds a port itself and lets in only a holder of the token", () => {
    const argv = serverArgs("C:\\h\\t");
    const option = (name: string) => argv[argv.indexOf(name) + 1];

    // Port 0: no port is picked in advance for something else to take first.
    expect(option("--listen")).toBe("ws://127.0.0.1:0");
    expect([option("--ws-auth"), option("--ws-token-file")]).toEqual([
      "capability-token",
      "C:\\h\\t",
    ]);
  });
});

describe("who holds a loopback port", () => {
  windowsOnly("is trusted only as the recorded process: its pid and its creation time", () => {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const listen = `ws://127.0.0.1:${server.port}`;
    const created = String(processCreated(process.pid));

    try {
      expect(ownsListen(listen, process.pid, created)).toBe(true);
      // Another process on the port, or a later one given the recorded pid.
      expect(ownsListen(listen, process.ppid, created)).toBe(false);
      expect(ownsListen(listen, process.pid, String(BigInt(created) - 1n))).toBe(false);
      expect(ownsListen(listen, process.pid, undefined)).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});
