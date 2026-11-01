/**
 * The shared Codex app-server on Windows. Codex refuses a Unix socket there ("not
 * private to the current user"), so it listens on loopback: on a port it binds
 * itself (`:0`), behind a capability token in a user-only file. It runs in a
 * kill-on-close Job Object, its port is the listener a process in that job holds,
 * and before anything is sent to it that listener must still be the recorded process.
 * See docs/adr/0061-windows-process-trees.md.
 */
import { harnessEnv } from "../environment.ts";
import { killTree } from "../../platform/processes.ts";
import {
  type JobProcess,
  loopbackListeners,
  processCreated,
  spawnInJob,
} from "../../platform/windowsNative.ts";
import { writeToken } from "./windowsToken.ts";

/** The pids holding the loopback `port` now; more than one only through `SO_REUSEADDR`. */
const holdersOf = (port: number): ReadonlySet<number> =>
  new Set(
    loopbackListeners()
      .filter((listener) => listener.port === port)
      .map((listener) => listener.pid)
  );

/** The one pid listening on the loopback `port` right now, or null if none or several are. */
export const listenerOn = (port: number): number | null => {
  const [pid, ...others] = holdersOf(port);

  return pid === undefined || others.length > 0 ? null : pid;
};

/** Whether `pid` is still the process created at `created`: a pid alone can name a later one. */
export const isSameProcess = (pid: number, created: string | undefined): boolean =>
  created !== undefined && String(processCreated(pid)) === created;

/**
 * True while the recorded listener, the same process it was, is the only one on `listen`'s
 * port: no token, prompt or code goes to a process that took over its pid or port.
 */
export const ownsListen = (
  listen: string,
  listenerPid: number,
  listenerCreated: string | undefined
): boolean =>
  listenerOn(Number(new URL(listen).port)) === listenerPid &&
  isSameProcess(listenerPid, listenerCreated);

/** What codex is started with: a port it binds itself, and only a holder of the token let in. */
export const serverArgs = (tokenFile: string): Array<string> => [
  "app-server",
  "--listen",
  "ws://127.0.0.1:0",
  "--ws-auth",
  "capability-token",
  "--ws-token-file",
  tokenFile,
];

export interface WindowsLaunched {
  readonly pid: number;
  readonly listen: string;
  /** The process that owns the port: codex.exe, below the shim's cmd.exe and node. */
  readonly listenerPid: number;
  /** Its creation time (a FILETIME), so a later process given its pid is never taken for it. */
  readonly listenerCreated: string;
}

/** The servers this Daemon started, by root pid: held open, so that pid is never reused. */
const owned = new Map<number, JobProcess>();

/** Ends every server this Daemon started, as its scope closes. */
export const stopOwnedWindowsServers = async (): Promise<void> => {
  const jobs = [...owned.values()];
  owned.clear();
  await Promise.all(jobs.map((job) => job.stop()));
};

/**
 * Ends a recorded server. One this Daemon started ends with its job. One a previous Daemon
 * left is ended only while it is still that server: the same process, running `app-server`
 * on this home's token file (`isOurs`).
 */
export const stopWindowsServer = async (
  state: {
    readonly pid: number;
    readonly listenerPid?: number | undefined;
    readonly listenerCreated?: string | undefined;
  },
  isOurs: (pid: number) => boolean
): Promise<number | null> => {
  const job = owned.get(state.pid);

  if (job !== undefined) {
    owned.delete(state.pid);
    await job.stop();

    return state.pid;
  }

  const rootIsOurs = isOurs(state.pid);

  if (rootIsOurs) await killTree(state.pid, "SIGKILL");

  const { listenerPid, listenerCreated } = state;

  const listenerIsOurs =
    listenerPid !== undefined && isSameProcess(listenerPid, listenerCreated) && isOurs(listenerPid);

  if (listenerIsOurs) await killTree(listenerPid, "SIGKILL");

  return rootIsOurs || listenerIsOurs ? state.pid : null;
};

/**
 * Starts the server in its own job, its output appended to `logFile`, and waits until it
 * is bound. Not detached: see "lives as long as the Daemon" in the ADR.
 */
export const windowsLaunch = async (options: {
  readonly codexPath: string;
  readonly tokenFile: string;
  readonly logFile: string;
  readonly timeoutMs: number;
}): Promise<WindowsLaunched> => {
  writeToken(options.tokenFile);

  const job = spawnInJob({
    argv: [options.codexPath, ...serverArgs(options.tokenFile)],
    env: harnessEnv(),
    logFile: options.logFile,
  });

  owned.set(job.pid, job);

  try {
    return await bound(job, Date.now() + options.timeoutMs);
  } catch (error) {
    owned.delete(job.pid);
    await job.stop();
    throw error;
  }
};

/** Waits for the listener a process in `job` holds; other listeners are not ours. */
const bound = async (job: JobProcess, deadline: number): Promise<WindowsLaunched> => {
  while (Date.now() < deadline && job.alive()) {
    const inJob = new Set(job.pids());
    const ours = loopbackListeners().filter((listener) => inJob.has(listener.pid));

    if (ours.length > 1) throw new Error(`the server started holds ${ours.length} ports`);
    const [listener] = ours;
    const created = listener === undefined ? null : processCreated(listener.pid);

    if (listener !== undefined && created !== null)
      return {
        pid: job.pid,
        listen: `ws://127.0.0.1:${listener.port}`,
        listenerPid: listener.pid,
        listenerCreated: String(created),
      };

    await Bun.sleep(50);
  }

  throw new Error("codex app-server did not start listening");
};
