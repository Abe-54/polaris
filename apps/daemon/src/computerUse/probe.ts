/**
 * What computer use reads of its Host to answer its status: the platform, the Daemon's own
 * environment, a few files and sockets, and short commands. The only process boundary here.
 */
import { readdir, stat } from "node:fs/promises";
import { connect } from "node:net";
import { findExecutable } from "../platform/executable.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export interface ProbePaths {
  /** macOS: owned by the user logged in at the screen (root at the login window). */
  readonly console: string;
  /** Linux: X11's sockets, `X<n>` for display `:n`. */
  readonly x11: string;
  /** Linux: `<root>/<uid>` is a user's runtime directory when XDG_RUNTIME_DIR is unset. */
  readonly runtimeRoot: string;
  /** Linux: the D-Bus service files at-spi2-core installs; one is enough. */
  readonly a11yServices: ReadonlyArray<string>;
}

export const HOST_PATHS: ProbePaths = {
  console: "/dev/console",
  x11: "/tmp/.X11-unix",
  runtimeRoot: "/run/user",
  a11yServices: [
    "/usr/share/dbus-1/services/org.a11y.Bus.service",
    "/usr/local/share/dbus-1/services/org.a11y.Bus.service",
  ],
};

export interface Ran {
  /** The exit code; 127 when the command isn't on PATH, 124 when it timed out. */
  readonly code: number;
  readonly stdout: string;
}

export interface HostProbe {
  readonly platform: NodeJS.Platform;
  readonly uid: number | null;
  readonly pid: number;
  readonly env: Env;
  readonly paths: ProbePaths;
  /** Runs a command found on the Daemon's PATH, with `env` merged over the Daemon's. */
  readonly run: (argv: ReadonlyArray<string>, env?: Env) => Promise<Ran>;
  /** Whether the command is on the Daemon's PATH. */
  readonly has: (command: string) => boolean;
  readonly exists: (path: string) => Promise<boolean>;
  /** Whether something accepts connections on the Unix socket at `path`. */
  readonly listening: (path: string) => Promise<boolean>;
  readonly ownerUid: (path: string) => Promise<number | null>;
  /** The names in a directory; none when it is missing. */
  readonly list: (dir: string) => Promise<ReadonlyArray<string>>;
}

const RUN_TIMEOUT_MS = 5000;

const CONNECT_TIMEOUT_MS = 1000;

const listening = (path: string) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(path);

    const done = (live: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(live);
    };

    const timer = setTimeout(() => done(false), CONNECT_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });

/** `env` without its unset names, as a child process takes it. */
export const defined = (env: Env): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );

export interface ProbeOptions {
  readonly platform?: NodeJS.Platform;
  readonly uid?: number | null;
  readonly env?: Env;
  readonly paths?: Partial<ProbePaths>;
}

/** This Host as the Daemon sees it; tests point `env` (with PATH) and `paths` at fakes. */
export const hostProbe = (options: ProbeOptions = {}): HostProbe => {
  const env = options.env ?? process.env;
  const which = (command: string) => findExecutable(command, { PATH: env.PATH ?? "" });

  return {
    platform: options.platform ?? process.platform,
    uid: options.uid === undefined ? (process.getuid?.() ?? null) : options.uid,
    pid: process.pid,
    env,
    paths: { ...HOST_PATHS, ...options.paths },
    has: (command) => which(command) !== null,
    run: async ([command = "", ...args], extra = {}) => {
      const resolved = which(command);

      if (resolved === null) return { code: 127, stdout: "" };

      const proc = Bun.spawn([resolved, ...args], {
        env: defined({ ...env, ...extra }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        timeout: RUN_TIMEOUT_MS,
      });

      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

      return { code: proc.signalCode === null ? code : 124, stdout };
    },
    exists: (file) =>
      stat(file).then(
        () => true,
        () => false
      ),
    listening,
    ownerUid: (file) =>
      stat(file).then(
        (facts) => facts.uid,
        () => null
      ),
    list: (dir) => readdir(dir).catch(() => []),
  };
};
