import { expect, test } from "bun:test";
import { copyFileSync, linkSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import { Schema } from "effect";
import { claudeExecutable, type Start, spawnWith } from "./executable.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

const SHIM = "C:\\npm\\claude.cmd";

test.each([
  {
    name: "npm's claude.exe is started directly",
    launch: { program: "C:\\npm\\node_modules\\claude\\bin\\claude.exe", args: [] },
    expected: { pathToClaudeCodeExecutable: "C:\\npm\\node_modules\\claude\\bin\\claude.exe" },
  },
  {
    name: "a node the shim doesn't name by absolute path isn't trusted",
    launch: { program: "node.exe", args: ["C:\\npm\\node_modules\\claude\\cli.js"] },
    expected: { pathToClaudeCodeExecutable: SHIM },
  },
  {
    name: "a shim the SDK can't run another way keeps its path",
    launch: { program: "C:\\perl\\perl.exe", args: ["C:\\npm\\node_modules\\claude\\cli"] },
    expected: { pathToClaudeCodeExecutable: SHIM },
  },
])("$name", ({ launch, expected }) => {
  expect(claudeExecutable(SHIM, launch)).toEqual(expected);
});

test("npm's cli.js runs under the shim's own node, never a bare one", async () => {
  const seen = newTempDir("polaris-node-");
  const node = join(seen, process.platform === "win32" ? "node.exe" : "node");

  // A hard link can't cross volumes (CI's temp is on another drive on Windows).
  try {
    linkSync(process.execPath, node);
  } catch {
    copyFileSync(process.execPath, node);
  }

  const options = claudeExecutable(SHIM, {
    program: node,
    args: ["C:\\npm\\node_modules\\claude\\cli.js"],
  });

  expect(options.pathToClaudeCodeExecutable).toBe("C:\\npm\\node_modules\\claude\\cli.js");
  expect(options.executable).toBe("node");

  // The SDK asks for `node`; the spawn runs the absolute program the shim named instead.
  const script = join(seen, "argv.js");
  writeFileSync(
    script,
    "console.log(JSON.stringify([process.execPath, ...process.argv.slice(2)]))"
  );

  const child = options.spawnClaudeCodeProcess?.({
    command: "node",
    args: [script, "--print"],
    cwd: seen,
    // No PATH: a bare `node` can't be found, so only the shim's absolute node can run.
    env: { ...process.env, PATH: "", Path: "" },
    signal: new AbortController().signal,
  });

  const exited = new Promise((resolve) => child?.on("exit", resolve));
  const out = await new Response(child?.stdout).text();

  // Windows can't remove the copied node while it still runs.
  await exited;

  // A hard link has two names and macOS may report either: compare the file, not the path.
  const [ran = "", ...argv] = Schema.decodeUnknownSync(Schema.Array(Schema.String))(
    JSON.parse(out)
  );

  const identity = (path: string) => ({ dev: statSync(path).dev, ino: statSync(path).ino });

  expect(identity(ran)).toEqual(identity(node));
  expect(argv).toEqual(["--print"]);
  removeTempDir(seen);
});

test("a child gone without the exit Bun lost still exits for the SDK (ENG-357)", async () => {
  const finished = Bun.spawn([process.execPath, "-e", ""]);
  await finished.exited;

  // A child node never reports exiting: its stdout closes, its PID is gone, `exit` never comes.
  const silent: Start = () => {
    const stdout = new PassThrough();

    const child = Object.defineProperties(new ChildProcess(), {
      pid: { value: finished.pid },
      stdin: { value: new PassThrough() },
      stdout: { value: stdout },
      stderr: { value: new PassThrough() },
    });

    queueMicrotask(() => stdout.end());

    // SAFETY: the properties defined above give the child its three pipes.
    return child as ChildProcessWithoutNullStreams;
  };

  const child = spawnWith(
    process.execPath,
    silent
  )({
    command: "node",
    args: [],
    env: {},
    signal: new AbortController().signal,
  });

  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  child.stdout.resume();

  expect(await exited).toBeNull();
}, 10_000);
