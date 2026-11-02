#!/usr/bin/env bun
/**
 * `bun test` with a stall watchdog: when the run prints nothing for
 * `POLARIS_TEST_STALL_S` seconds (default 300), it is killed, with its process
 * group, and the files still running are named, so a hang fails instead of waiting forever.
 *
 *   bun ../../tooling/test/watchdog.ts [bun test args…]
 *
 * With `--parallel=N` or `--isolate`, bun's reporter interleaves the files and never says
 * when one ends, so the watchdog adds a preload (`progress.ts`) that marks each file's start and end.
 *
 * Local runs are parallel by default (`parallel.ts`); `POLARIS_TEST_PARALLEL=N` overrides, 1 is serial.
 */
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PROGRESS_MARKER } from "./marker.ts";
import { parallelFlags } from "./parallel.ts";

/** What the run has shown so far, read from bun's per-file reporter and the progress markers. */
interface Progress {
  /** The file bun's last header named. */
  readonly current: string | null;
  /** Each file's last result. */
  readonly lastTest: ReadonlyMap<string, string>;
  /** Files started and not ended, from the markers; serial runs have none. */
  readonly running: ReadonlySet<string>;
  /** The files that ended last, the latest last. */
  readonly ended: ReadonlyArray<string>;
  readonly started: boolean;
}

const initialProgress: Progress = {
  current: null,
  lastTest: new Map(),
  running: new Set(),
  ended: [],
  started: false,
};

/** Under GitHub Actions bun wraps each file header in a `::group::` log group. */
const FILE_HEADER = /^(?:::group::)?(\S.*\.(?:test|spec)\.[cm]?[jt]sx?):$/;

const TEST_LINE = /^\((?:pass|fail|skip|todo)\) /;

const MARKER_LINE = /^(start|end) (.+)$/;

/** A stall between files names the last few that ended: one of them left its worker busy. */
const ENDED_KEPT = 4;

const observeMarker = (progress: Progress, marker: string): Progress => {
  const [, kind, file] = MARKER_LINE.exec(marker) ?? [];

  if (!file) return progress;
  const running = new Set(progress.running);

  if (kind === "start") return { ...progress, running: running.add(file), started: true };
  running.delete(file);

  return { ...progress, running, ended: [...progress.ended, file].slice(-ENDED_KEPT) };
};

const observe = (progress: Progress, line: string): Progress => {
  if (line.startsWith(PROGRESS_MARKER))
    return observeMarker(progress, line.slice(PROGRESS_MARKER.length));

  const header = FILE_HEADER.exec(line)?.[1];

  if (header) return { ...progress, current: header, started: true };

  if (TEST_LINE.test(line) && progress.current) {
    const lastTest = new Map(progress.lastTest);

    lastTest.set(progress.current, line);

    return { ...progress, lastTest };
  }

  return progress;
};

const describeFile = (progress: Progress, file: string) => {
  const last = progress.lastTest.get(file);

  return last ? `${file}\n  last result: ${last}` : file;
};

const stallReport = (progress: Progress, seconds: number, isolated: boolean): string => {
  const head = `bun test stalled: no output for ${seconds}s, in`;
  const files = isolated ? [...progress.running] : [progress.current].filter((f) => f !== null);
  const [only] = files;

  if (!only && isolated && progress.ended.length > 0)
    return `${head} no running test file, after: ${progress.ended.join(", ")}`;

  if (!only) {
    const where = progress.started
      ? "a test file that has not reported yet"
      : "before the first test file reported";

    return `${head} ${where}`;
  }

  if (files.length === 1) return `${head} ${describeFile(progress, only)}`;

  const list = files.map((file) => `- ${describeFile(progress, file)}`).join("\n");

  return `${head} ${files.length} files still running:\n${list}`;
};

/** Bun's reporter hides file headers from coding agents, and the watchdog needs them. */
const AGENT_ENV = ["CLAUDECODE", "AI_AGENT", "CLAUDE_CODE_ENTRYPOINT", "CURSOR_AGENT"];

const quiet = AGENT_ENV.some((name) => process.env[name]);

const hidden = (line: string) =>
  line.startsWith(PROGRESS_MARKER) ||
  (quiet && (line.startsWith("(pass) ") || FILE_HEADER.test(line)));

const ISOLATING = /^--(?:parallel|isolate)(?:=|$)/;

/** Every process below `root`, from `ps` (POSIX). */
const descendants = (root: number): ReadonlyArray<number> => {
  const listing = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).stdout ?? "";
  const children = new Map<number, Array<number>>();

  for (const line of listing.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);

    if (pid && ppid) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }

  const found: Array<number> = [];

  for (let queue = [root]; queue.length > 0;) {
    const next = queue.flatMap((pid) => children.get(pid) ?? []);

    found.push(...next);
    queue = next;
  }

  return found;
};

const run = async (given: ReadonlyArray<string>): Promise<number> => {
  const args = [...parallelFlags(given, process.env), ...given];
  const stallSeconds = Number(process.env.POLARIS_TEST_STALL_S ?? 300);
  const isolated = args.some((arg) => ISOLATING.test(arg));
  const env = { ...process.env };

  for (const name of AGENT_ENV) delete env[name];

  const preload = isolated ? ["--preload", join(import.meta.dir, "progress.ts")] : [];

  const child = spawn("bun", ["test", ...preload, ...args], {
    env,
    detached: process.platform !== "win32",
    stdio: ["inherit", "pipe", "pipe"],
  });

  const killGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;

    // Windows has no process groups: taskkill ends bun and the parallel workers below it.
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });

      return;
    }

    // Parallel workers each lead a process group of their own, outliving bun's.
    for (const pid of [child.pid, ...descendants(child.pid)]) {
      try {
        process.kill(-pid, signal);
      } catch {
        // Not a group leader, or already gone.
      }
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      killGroup(signal);
      process.exit(130);
    });

  let progress = initialProgress;
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      console.error(`\n${stallReport(progress, stallSeconds, isolated)}`);
      killGroup("SIGKILL");
    }, stallSeconds * 1000);
  };

  const follow = (stream: NodeJS.ReadableStream, write: (line: string) => void) =>
    createInterface({ input: stream }).on("line", (line) => {
      arm();
      progress = observe(progress, line);

      if (!hidden(line)) write(line);
    });

  follow(child.stdout, (line) => console.log(line));
  follow(child.stderr, (line) => console.error(line));
  arm();

  const code = await new Promise<number>((resolve) =>
    child.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)))
  );

  clearTimeout(timer);

  return stalled ? 1 : code;
};

if (import.meta.main) process.exit(await run(process.argv.slice(2)));
