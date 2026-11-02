/**
 * The binary the shared Codex app-server runs as. On Linux Codex's sandbox runs commands through
 * bubblewrap, which first runs that same binary inside the sandbox to apply seccomp, so a
 * read-only thread must be able to read it. See docs/adr/0055-the-reviewer-reads-only-its-checkout.md.
 */
import { readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { readAppServerState } from "./AppServer.ts";

const readOr = <A>(read: () => A, fallback: A): A => {
  try {
    return read();
  } catch {
    return fallback;
  }
};

/** A process's children started by its main thread (`/proc/<pid>/task/<pid>/children`). */
const childrenOf = (proc: string, pid: number): ReadonlyArray<number> => {
  const tasks = readOr(
    () => readFileSync(join(proc, String(pid), "task", String(pid), "children"), "utf8"),
    ""
  );

  return tasks
    .split(/\s+/)
    .filter((part) => part !== "")
    .map(Number)
    .filter((child) => Number.isInteger(child) && child > 0);
};

const isAppServer = (proc: string, pid: number) =>
  readOr(() => readFileSync(join(proc, String(pid), "cmdline"), "utf8"), "")
    .split("\0")
    .includes("app-server");

/**
 * The real path of the binary `pid` runs, following launchers down: an npm install starts the
 * native `codex` as a child of `node`, with the same `app-server` arguments. Null off Linux.
 */
export const executableOf = (pid: number, proc = "/proc"): string | null => {
  const child = childrenOf(proc, pid).find((candidate) => isAppServer(proc, candidate));

  if (child !== undefined) return executableOf(child, proc);

  return readOr(() => readlinkSync(join(proc, String(pid), "exe")), null);
};

/** The recorded app-server's binary on Linux, where Codex's sandbox runs it; null elsewhere. */
export const appServerExecutable = (
  stateFile: string,
  platform: NodeJS.Platform = process.platform
): string | null => {
  if (platform !== "linux") return null;
  const state = readAppServerState(stateFile);

  return state === null ? null : executableOf(state.pid);
};
