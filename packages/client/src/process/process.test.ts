/**
 * `ChildProcess`'s contract: hidden unless asked to be seen, a child that never started is
 * classified, and stopping one ends it. The callers (install commands, the ssh and wsl
 * transports, WSL discovery) run against the scripted Layer, so nothing here needs ssh,
 * sh or wsl.exe, and it runs on the Windows CI leg too.
 */
import { describe, expect, test } from "bun:test";
import { type SpawnOptions, spawn } from "node:child_process";
import { Effect } from "effect";
import { runCommand } from "../install/Ssh.ts";
import { spawnTransport } from "../transport.ts";
import { discoverDistros } from "../wsl/distros.ts";
import {
  ChildProcess,
  type ChildProcessApi,
  nodeChildProcess,
  type ScriptedProcess,
  type SpawnRequest,
  spawnFailed,
  stopChild,
} from "./index.ts";

const scripted = (script: (request: SpawnRequest) => ScriptedProcess): ChildProcessApi =>
  Effect.runSync(
    ChildProcess.useSync((service) => service).pipe(Effect.provide(ChildProcess.test(script)))
  );

const recorded = () => {
  const seen: Array<SpawnOptions> = [];

  // SAFETY: records the options and delegates; the overload set is wider than this call.
  const recording = ((file: string, args: ReadonlyArray<string>, options: SpawnOptions) => {
    seen.push(options);

    return spawn(file, args, options);
  }) as typeof spawn;

  return { seen, processes: nodeChildProcess(recording) };
};

const exited = (child: ReturnType<ChildProcessApi["spawn"]>) =>
  new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

describe("ChildProcess.node", () => {
  test("hides every child's console window unless the caller wants it seen", async () => {
    const { seen, processes } = recorded();
    const script = ["-e", "process.exit(0)"];

    await exited(processes.spawn({ file: process.execPath, args: script }));
    await exited(processes.spawn({ file: process.execPath, args: script, visible: true }));
    expect(seen.map((options) => options.windowsHide)).toEqual([true, false]);
  });

  test("passes cwd, detached, verbatim arguments and the timeout through", async () => {
    const { seen, processes } = recorded();

    const child = processes.spawn({
      file: process.execPath,
      args: ["-e", "process.exit(3)"],
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
      verbatimArguments: true,
      timeoutMs: 5000,
    });

    expect(await exited(child)).toBe(3);
    expect(seen[0]).toMatchObject({
      cwd: process.cwd(),
      detached: true,
      windowsVerbatimArguments: true,
      timeout: 5000,
      stdio: ["ignore", "ignore", "ignore"],
    });
  });

  test("a program that doesn't exist fails to start as missing", async () => {
    const child = nodeChildProcess().spawn({ file: "polaris-no-such-program", args: [] });

    const error = await new Promise<NodeJS.ErrnoException>((resolve) =>
      child.once("error", resolve)
    );

    expect(spawnFailed("polaris-no-such-program", error)).toMatchObject({
      reason: "missing",
      code: "ENOENT",
    });
  });

  test("stopChild ends a running child", async () => {
    const child = nodeChildProcess().spawn({
      file: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    });

    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    await stopChild(child, 2000);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});

describe("spawn failures", () => {
  test("are classified by errno", () => {
    const failure = (code: string) =>
      spawnFailed("x", Object.assign(new Error(code), { code })).reason;

    expect([failure("ENOENT"), failure("EACCES"), failure("EPERM"), failure("EBUSY")]).toEqual([
      "missing",
      "denied",
      "denied",
      "failed",
    ]);
  });
});

describe("callers on the scripted Layer", () => {
  test("an install command gets its output and exit code", async () => {
    const requests: Array<SpawnRequest> = [];

    const processes = scripted((request) => {
      requests.push(request);

      return { exit: { code: 7, stdout: "out", stderr: "err" } };
    });

    const result = await Effect.runPromise(
      runCommand({
        alias: "studio",
        file: "ssh",
        args: ["studio"],
        transportFailure: 255,
        processes,
      })
    );

    expect(result).toEqual({ code: 7, stdout: "out", stderr: "err" });
    expect(requests[0]?.visible).toBeUndefined();
  });

  test("an install command whose program is missing is an ssh spawn failure", async () => {
    const processes = scripted(() => ({ spawnError: "ENOENT" }));

    const error = await Effect.runPromise(
      runCommand({ alias: "studio", file: "ssh", args: [], transportFailure: 255, processes }).pipe(
        Effect.flip
      )
    );

    expect(error.failure).toBe("spawn");
  });

  test("a bridge whose program is missing reads as the Host kind's missing tool", async () => {
    const processes = scripted(() => ({ spawnError: "ENOENT" }));

    const failure = await Effect.runPromise(
      Effect.scoped(
        spawnTransport(["C:\\Git\\usr\\bin\\ssh.exe", "studio"], {
          processes,
          spawnFailureReason: "ssh-missing",
        })
      ).pipe(Effect.flip)
    );

    expect(failure).toMatchObject({
      reason: "ssh-missing",
      detail: "C:\\Git\\usr\\bin\\ssh.exe: ENOENT",
    });
  });

  test("WSL discovery reads the distro list from wsl.exe, and a missing wsl.exe", async () => {
    const list = "  NAME      STATE      VERSION\n* Ubuntu    Running    2\n";

    const found = await Effect.runPromise(
      discoverDistros({
        platform: "win32",
        processes: scripted(() => ({ exit: { code: 0, stdout: list } })),
      })
    );

    expect(found._tag).toBe("Distros");

    const missing = await Effect.runPromise(
      discoverDistros({ platform: "win32", processes: scripted(() => ({ spawnError: "ENOENT" })) })
    );

    expect(missing._tag).toBe("NotInstalled");
  });
});
