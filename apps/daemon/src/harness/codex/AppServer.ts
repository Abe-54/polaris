/**
 * The one `codex app-server` per Host, shared by every Codex Agent Session and
 * by the user's own `codex --remote` TUI.
 *
 * It listens on a Unix socket (`codex app-server --listen unix://<path>`) and
 * is started lazily on the first `open`. It is **not** a child of the Daemon:
 * it is started detached (its own session, reparented to init, stdio on a log
 * file), so it outlives Daemon restarts, crashes and execve upgrades, and a
 * co-attached TUI keeps running through them. Its pid and codex version are
 * recorded in a state file next to the socket (`~/.polaris/codex-app-server.json`).
 *
 * A Daemon that finds something answering on the socket adopts it. Before
 * this Daemon has any connection of its own, it compares the recorded version
 * with the installed `codex --version`; if codex was upgraded and the server
 * has no thread loaded (`thread/loaded/list` is empty, so no session or TUI is
 * live on it), the old server is stopped and a new one started. Otherwise the
 * old server is kept until a later `open` finds it idle.
 *
 * Under systemd, stopping or restarting `polaris.service` kills its whole
 * cgroup regardless of sessions, so there the server is started in its own
 * transient scope with `systemd-run --user --scope`.
 *
 * `polaris uninstall` stops it (`stopAppServer`).
 */
import { harnessEnv } from "../environment.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect, Option, Schema, type Scope, Semaphore } from "effect";
import type { HarnessError } from "../HarnessDriver.ts";
import { ThreadLoadedListResponse } from "./protocol.ts";
import {
  codexError,
  codexNotInstalled,
  connectUnix,
  connectWebSocket,
  type RpcConnection,
} from "./RpcConnection.ts";
import { commandLineOf, encodePowershell, powershellQuote } from "../../platform/processes.ts";
import { which } from "../../service/userPath.ts";
import { ownerOf, thisUserSid, writePrivateFile } from "../../platform/windowsNative.ts";
import {
  ownsListen,
  stopOwnedWindowsServers,
  stopWindowsServer,
  type WindowsLaunched,
  windowsLaunch,
} from "./windowsServer.ts";
import { isTrustedOwner, tokenFileOf } from "./windowsToken.ts";

const windows = process.platform === "win32";

export interface AppServerOptions {
  readonly codexPath: string | null;
  readonly socketPath: string;
  /** False: only connect to a server someone else runs (tests, externally managed servers). */
  readonly spawn: boolean;
  readonly startTimeoutMs?: number;
  /** Where pid and version are recorded. Default: `codex-app-server.json` beside the socket. */
  readonly stateFile?: string;
  /** The server's stdout and stderr. Default: `logs/codex-app-server.log` beside the socket. */
  readonly logFile?: string;
  /** The installed codex version; defaults to parsing `codex --version`. */
  readonly codexVersion?: (codexPath: string) => Effect.Effect<string | null>;
  /** Use `systemd-run --user --scope` when running under systemd (default: autodetect). */
  readonly systemdRun?: string | null;
}

export interface AppServer {
  readonly socketPath: string;
  /** Its recorded pid and version (and on Windows its URL). */
  readonly stateFile: string;
  /** Connects to the shared server, starting it first if nothing answers on the socket. */
  readonly connect: Effect.Effect<RpcConnection, HarnessError, Scope.Scope>;
}

export const AppServerState = Schema.Struct({
  pid: Schema.Int,
  /** `codex --version` of the binary that was started, or null if it didn't say. */
  version: Schema.NullOr(Schema.String),
  codexPath: Schema.String,
  socketPath: Schema.String,
  startedAt: Schema.Number,
  /** Older servers may retain the execve envelope in their own environment. */
  sanitizedEnv: Schema.optional(Schema.Boolean),
  /** Windows: the loopback URL it listens on instead of the socket (see `windowsLaunch`). */
  listen: Schema.optional(Schema.String),
  /** Windows: the pid that owns that port, checked before anything is sent to it. */
  listenerPid: Schema.optional(Schema.Int),
  /** Windows: that process's creation time, so a later one given its pid is not taken for it. */
  listenerCreated: Schema.optional(Schema.String),
});

export type AppServerState = typeof AppServerState.Type;

export const defaultStateFile = (socketPath: string) =>
  join(dirname(socketPath), "codex-app-server.json");

export const defaultLogFile = (socketPath: string) =>
  join(dirname(socketPath), "logs", "codex-app-server.log");

export { tokenFileOf };

const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(AppServerState));

export const readAppServerState = (stateFile: string): AppServerState | null => {
  // On Windows its pids and URL decide where the token goes: only a file the user owns counts.
  if (windows && !isTrustedOwner(ownerOf(stateFile), thisUserSid())) return null;

  try {
    const state = decodeState(readFileSync(stateFile, "utf8"));

    return Option.getOrNull(state);
  } catch {
    return null;
  }
};

const writeState = (stateFile: string, state: AppServerState) => {
  mkdirSync(dirname(stateFile), { recursive: true });

  if (windows) return writePrivateFile(stateFile, `${JSON.stringify(state)}\n`);
  const temporary = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporary, stateFile);
};

const restartReason = (state: AppServerState, installed: string | null): string | null => {
  if (state.sanitizedEnv !== true) return "clear the legacy hand-off environment";

  if (installed === null || state.version === null || installed === state.version) return null;

  return `${state.version} → ${installed}`;
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    // ESRCH, or EPERM: it exists but isn't ours, so it can't be our server either.
    return false;
  }
};

/** True if `pid` is alive and still the app-server on `endpoint`, its socket or URL (pids get reused). */
export const isOurAppServer = (pid: number, endpoint: string): boolean => {
  if (!isAlive(pid)) return false;
  const command = commandLineOf(pid);

  return (command?.includes("app-server") && command.includes(endpoint)) === true;
};

/** What names a recorded server in its command line: its socket, or on Windows its token file. */
const endpointOf = (state: AppServerState, stateFile: string) =>
  state.listen === undefined ? state.socketPath : tokenFileOf(stateFile);

/**
 * Connects to the shared server: over its Unix socket, or on Windows to the URL
 * its state file records, with the capability token beside it.
 */
export const connectAppServer = (
  socketPath: string,
  stateFile: string = defaultStateFile(socketPath)
): Effect.Effect<RpcConnection, HarnessError, Scope.Scope> => {
  if (!windows) return connectUnix(socketPath);

  return Effect.suspend(() => {
    const state = readAppServerState(stateFile);
    const { listen, listenerPid, listenerCreated } = state ?? {};
    let token: string | null = null;

    if (listen === undefined || listenerPid === undefined)
      return Effect.fail(codexError(`No Codex app-server is recorded in ${stateFile}`));

    // Before the token goes out: whatever holds the port now must be the server we started.
    if (!ownsListen(listen, listenerPid, listenerCreated))
      return Effect.fail(codexError(`${listen} is not the recorded Codex app-server`));

    try {
      token = readFileSync(tokenFileOf(stateFile), "utf8").trim();
    } catch {}

    return token === null
      ? Effect.fail(codexError(`No Codex app-server token beside ${stateFile}`))
      : connectWebSocket(listen, listen, token);
  });
};

/** True when something accepts a WebSocket upgrade on the server's endpoint. */
const isAnswering = (socketPath: string, stateFile?: string) =>
  Effect.scoped(connectAppServer(socketPath, stateFile)).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false))
  );

/** `codex --version` → "0.157.1", or null. */
export const installedCodexVersion = (codexPath: string): Effect.Effect<string | null> =>
  Effect.promise(async () => {
    try {
      const proc = Bun.spawn([codexPath, "--version"], {
        env: harnessEnv(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        timeout: 5_000,
      });

      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

      return code === 0 ? (out.trim().match(/(\d+\.\d+\.\d+\S*)/)?.[1] ?? null) : null;
    } catch {
      return null;
    }
  });

/**
 * The systemd-run binary to start the server in its own scope with, when this
 * Daemon runs as a systemd unit (systemd sets `INVOCATION_ID`); else null.
 */
export const detectSystemdRun = (env: NodeJS.ProcessEnv = process.env): string | null =>
  process.platform === "linux" && env.INVOCATION_ID ? which("systemd-run") : null;

/**
 * The argv that starts a detached server and prints its pid. `sh` backgrounds
 * the server and exits at once, so the server is reparented to init and is no
 * child of the Daemon: nothing of the Daemon's (pipes, process group, the
 * PID an execve upgrade keeps) ties it to the Daemon's lifetime.
 */
export const launchArgv = (options: {
  readonly codexPath: string;
  readonly socketPath: string;
  readonly logFile: string;
  readonly systemdRun: string | null;
}): Array<string> => {
  const server = [options.codexPath, "app-server", "--listen", `unix://${options.socketPath}`];

  const command =
    options.systemdRun === null
      ? server
      : [
          options.systemdRun,
          "--user",
          "--scope",
          "--quiet",
          "--collect",
          `--unit=polaris-codex-app-server-${Date.now()}`,
          ...server,
        ];

  // "$@" keeps every argument intact; the log file is $0. Only the pid reaches our pipe.
  return ["/bin/sh", "-c", '"$@" </dev/null >>"$0" 2>&1 & echo $!', options.logFile, ...command];
};

/** What the state file records of a Windows server beyond the POSIX fields. */
const windowsFields = ({ listen, listenerPid, listenerCreated }: WindowsLaunched) => ({
  listen,
  listenerPid,
  listenerCreated,
});

/** A server just started: its pid, and on Windows the URL it listens on and who holds it. */
interface Launched {
  readonly pid: number;
  readonly windows: WindowsLaunched | null;
}

/** Runs `launchArgv`'s shell and returns the pid it printed. */
const posixLaunch = async (argv: Array<string>): Promise<Launched> => {
  const proc = Bun.spawn(argv, {
    env: harnessEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    detached: true,
  });

  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const pid = Number(out.trim());

  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`no pid from launcher: ${out}`);

  return { pid, windows: null };
};

const decodeLoadedList = Schema.decodeUnknownOption(ThreadLoadedListResponse);

/** Loaded thread ids on the server (live sessions or TUIs); null if it can't say. */
const loadedThreads = (socketPath: string, stateFile: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const conn = yield* connectAppServer(socketPath, stateFile);
      yield* conn.request("initialize", {
        clientInfo: { name: "polaris", title: "Polaris", version: "0.0.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      yield* conn.notify("initialized");

      const result = decodeLoadedList(yield* conn.request("thread/loaded/list", {}));

      return Option.getOrNull(result)?.data ?? null;
    })
  ).pipe(
    Effect.timeout("5 seconds"),
    Effect.catch(() => Effect.succeed(null))
  );

/** Wait until `done()` or the deadline; true if it happened. */
const waitFor = (done: () => boolean | Promise<boolean>, timeoutMs: number) =>
  Effect.promise(async () => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (await done()) return true;
      await Bun.sleep(50);
    }

    return done();
  });

/**
 * Stop the recorded server (SIGTERM, then SIGKILL after 5 s) if it is still
 * the app-server on its socket, and remove the state file and socket.
 * Used by `polaris uninstall` and when codex was upgraded.
 */
export const stopAppServer = (options: {
  readonly stateFile: string;
  readonly socketPath?: string;
}): Effect.Effect<{ readonly stopped: number | null }> =>
  Effect.gen(function* () {
    const state = readAppServerState(options.stateFile);
    const socketPath = options.socketPath ?? state?.socketPath;
    let stopped: number | null = null;

    const isOurs = (pid: number) =>
      state !== null && isOurAppServer(pid, endpointOf(state, options.stateFile));

    if (windows && state !== null) {
      stopped = yield* Effect.promise(() => stopWindowsServer(state, isOurs));
    } else if (state !== null && isOurs(state.pid)) {
      stopped = state.pid;
      yield* Effect.sync(() => process.kill(state.pid, "SIGTERM"));
      const exited = yield* waitFor(() => !isAlive(state.pid), 5_000);

      if (!exited) yield* Effect.sync(() => process.kill(state.pid, "SIGKILL"));
    }

    yield* Effect.sync(() => {
      rmSync(options.stateFile, { force: true });
      rmSync(tokenFileOf(options.stateFile), { force: true });

      if (socketPath !== undefined) rmSync(socketPath, { force: true });
    });

    return { stopped };
  });

export const acquireAppServer = (
  options: AppServerOptions
): Effect.Effect<AppServer, never, Scope.Scope> =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const stateFile = options.stateFile ?? defaultStateFile(options.socketPath);
    const logFile = options.logFile ?? defaultLogFile(options.socketPath);
    const versionOf = options.codexVersion ?? installedCodexVersion;
    const systemdRun = options.systemdRun === undefined ? detectSystemdRun() : options.systemdRun;
    /** This Daemon's open connections; the upgrade check only runs when there are none. */
    let connections = 0;
    let loggedLegacyEnv = false;

    // Windows: the server is this Daemon's child (see windowsServer.ts) and ends with it.
    if (windows)
      yield* Effect.addFinalizer(() =>
        stopAppServer({ stateFile, socketPath: options.socketPath }).pipe(
          Effect.andThen(Effect.promise(stopOwnedWindowsServers))
        )
      );

    const logKeepingServer = (state: AppServerState, reason: string) =>
      Effect.sync(() => {
        if (state.sanitizedEnv !== true && loggedLegacyEnv) return;

        if (state.sanitizedEnv !== true) loggedLegacyEnv = true;

        return `codex app-server has live or unknown threads; deferring ${reason}`;
      }).pipe(
        Effect.flatMap((message) => (message === undefined ? Effect.void : Effect.logInfo(message)))
      );

    const logTail = () => {
      try {
        return readFileSync(logFile, "utf8").slice(-2000).trim();
      } catch {
        return "";
      }
    };

    const spawn = Effect.gen(function* () {
      const codexPath = options.codexPath;

      if (codexPath === null) return yield* codexNotInstalled();
      // A recorded server that is alive but not answering is hung: replace it.
      const previous = readAppServerState(stateFile);

      // On Windows a crashed Daemon's server may be orphaned: stopAppServer finds its listener.
      if (
        previous !== null &&
        (windows || isOurAppServer(previous.pid, endpointOf(previous, stateFile)))
      ) {
        yield* stopAppServer({ stateFile, socketPath: options.socketPath });
      }

      mkdirSync(dirname(options.socketPath), { recursive: true });
      mkdirSync(dirname(logFile), { recursive: true });

      if (existsSync(options.socketPath)) rmSync(options.socketPath, { force: true });
      const version = yield* versionOf(codexPath);

      const timeoutMs = options.startTimeoutMs ?? 15_000;

      const { pid, windows: bound } = yield* Effect.tryPromise({
        try: (): Promise<Launched> =>
          windows
            ? windowsLaunch({
                codexPath,
                tokenFile: tokenFileOf(stateFile),
                logFile,
                timeoutMs,
              }).then((launched) => ({ pid: launched.pid, windows: launched }))
            : posixLaunch(
                launchArgv({ codexPath, socketPath: options.socketPath, logFile, systemdRun })
              ),
        catch: (cause) => codexError("Failed to start codex app-server", cause),
      });

      const started = {
        pid,
        version,
        codexPath,
        socketPath: options.socketPath,
        startedAt: Date.now(),
        sanitizedEnv: true,
      } satisfies AppServerState;

      yield* Effect.sync(() =>
        writeState(stateFile, bound === null ? started : { ...started, ...windowsFields(bound) })
      );

      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        if (!isAlive(pid))
          return yield* codexError(`codex app-server exited at start: ${logTail()}`);

        if (yield* isAnswering(options.socketPath, stateFile)) return;
        yield* Effect.sleep("100 millis");
      }

      yield* stopAppServer({ stateFile, socketPath: options.socketPath });

      return yield* codexError(`codex app-server did not start listening on ${options.socketPath}`);
    });

    /** Replace outdated or legacy-environment servers only when nothing is live on them. */
    const replaceIfOutdated = Effect.gen(function* () {
      if (!options.spawn || options.codexPath === null || connections > 0) return;
      const state = readAppServerState(stateFile);

      if (state === null || state.socketPath !== options.socketPath) return;
      const installed = yield* versionOf(options.codexPath);
      const reason = restartReason(state, installed);

      if (reason === null) return;
      const loaded = yield* loadedThreads(options.socketPath, stateFile);

      if (loaded === null || loaded.length > 0) {
        yield* logKeepingServer(state, reason);

        return;
      }

      yield* Effect.logInfo(`restarting codex app-server: ${reason}`);
      yield* stopAppServer({ stateFile, socketPath: options.socketPath });
    });

    const ensureRunning = lock.withPermits(1)(
      Effect.gen(function* () {
        if (yield* isAnswering(options.socketPath, stateFile)) {
          yield* replaceIfOutdated;

          if (yield* isAnswering(options.socketPath, stateFile)) return;
        }

        if (!options.spawn)
          return yield* codexError(`No Codex app-server is listening on ${options.socketPath}`);
        yield* spawn;
      })
    );

    const connect = Effect.gen(function* () {
      yield* ensureRunning;
      const conn = yield* connectAppServer(options.socketPath, stateFile);
      connections++;
      yield* Effect.addFinalizer(() => Effect.sync(() => connections--));

      return conn;
    });

    return { socketPath: options.socketPath, stateFile, connect } satisfies AppServer;
  });

/**
 * The argv of a `codex` TUI on the shared server's `threadId`. On Windows it
 * reads the token into its own environment, so the token never sits in an argv.
 */
export const remoteTuiArgv = (
  server: Pick<AppServer, "socketPath" | "stateFile">,
  codexPath: string,
  threadId: string,
  os: string = process.platform
): Array<string> => {
  const listen = os === "win32" ? readAppServerState(server.stateFile)?.listen : undefined;

  if (listen === undefined)
    return [codexPath, "resume", threadId, "--remote", `unix://${server.socketPath}`];

  const script = [
    `$env:POLARIS_CODEX_TOKEN = (Get-Content -Raw -LiteralPath ${powershellQuote(tokenFileOf(server.stateFile))}).Trim()`,
    `& ${powershellQuote(codexPath)} resume ${powershellQuote(threadId)} --remote ${powershellQuote(listen)} --remote-auth-token-env POLARIS_CODEX_TOKEN`,
    "exit $LASTEXITCODE",
  ].join("; ");

  return ["powershell.exe", "-NoLogo", "-NoProfile", "-EncodedCommand", encodePowershell(script)];
};
