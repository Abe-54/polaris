/**
 * The one `opencode serve` per Host (ENG-199 Q10, Q13). The Daemon owns it: it
 * starts on the first lease (an open session, or a Model listing), listens on
 * loopback only with a password generated per start, and stops as soon as the
 * last lease is released, i.e. once every OpenCode session is Dormant.
 *
 * Each start records `{ pid, url }`, so a Daemon that crashed and left its server
 * running stops it on the next start instead of leaking it.
 */
import { harnessEnv } from "../environment.ts";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Duration, Effect, Option, Schema, type Scope, Semaphore } from "effect";
import { paths } from "../../paths.ts";
import { HarnessError } from "../HarnessDriver.ts";
import { commandLineOf, killTree, stopChild } from "../../platform/processes.ts";
import { unsupportedOpenCode } from "./version.ts";

export const opencodeError = (message: string, cause?: unknown) =>
  new HarnessError({ harness: "opencode", message, cause });

/** Where a running server is, and how to authenticate to it. */
export interface ServerHandle {
  readonly url: string;
  readonly password: string;
  readonly opencodePath: string;
}

export interface OpenCodeServer {
  /** A lease on the running server, starting it if needed; released when the scope closes. */
  readonly lease: Effect.Effect<ServerHandle, HarnessError, Scope.Scope>;
  /** The file holding the running server's password (0600), for `opencode attach`. */
  readonly passwordFile: string;
  /** Whether a server is running now (for tests and the bench). */
  readonly running: Effect.Effect<boolean>;
}

export interface ServerOptions {
  /** Looked up on each start, so an OpenCode installed after the Daemon started is found. */
  readonly opencodePath: () => string | null;
  /** The server's environment; defaults to the Daemon's. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Directory for the state and password files; defaults to `~/.polaris`. */
  readonly stateDir?: string;
  readonly logFile?: string;
  readonly startTimeout?: Duration.Input;
}

const ServerState = Schema.fromJsonString(Schema.Struct({ pid: Schema.Int, url: Schema.String }));

const decodeState = Schema.decodeUnknownOption(ServerState);

const encodeState = Schema.encodeSync(ServerState);

const commandLine = (pid: number): string => commandLineOf(pid) ?? "";

/** Stops a server a previous Daemon recorded, if that pid is still an `opencode serve`. */
const stopStale = (stateFile: string) => {
  if (!existsSync(stateFile)) return;
  const state = Option.getOrNull(decodeState(readFileSync(stateFile, "utf8")));
  rmSync(stateFile, { force: true });

  if (state === null) return;
  const command = commandLine(state.pid);

  if (command.includes("opencode") && command.includes("serve")) {
    if (process.platform === "win32") void killTree(state.pid);
    else {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }
};

/** Reads the child's stdout until it prints its URL, then keeps draining it. */
const readUrl = async (stdout: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";

  for (;;) {
    const chunk = await reader.read();

    if (chunk.done)
      throw new Error(`opencode serve exited before listening${text ? `: ${text.trim()}` : ""}`);
    text += decoder.decode(chunk.value, { stream: true });
    const url = text.match(/listening on (http:\/\/\S+)/)?.[1];

    if (url !== undefined) {
      void (async () => {
        while (!(await reader.read()).done);
      })().catch(() => undefined);

      return url;
    }
  }
};

const decodeInfo = Schema.decodeUnknownOption(Schema.Struct({ version: Schema.String }));

/** OpenCode 2 answers `GET /api/info` with its version; OpenCode 1 serves no such route. */
const unsupportedServer = async (url: string, password: string): Promise<string | null> => {
  try {
    const response = await fetch(`${url}/api/info`, {
      headers: { authorization: `Basic ${btoa(`opencode:${password}`)}` },
      signal: AbortSignal.timeout(5_000),
    });

    const info = response.ok ? decodeInfo(await response.json()) : Option.none();

    return Option.isSome(info) ? unsupportedOpenCode(info.value.version) : null;
  } catch {
    return null;
  }
};

interface Running {
  readonly proc: Bun.Subprocess<"ignore", "pipe", Bun.BunFile>;
  readonly handle: ServerHandle;
  leases: number;
}

const stopProcess = (proc: Running["proc"]) =>
  Effect.promise(async () => {
    stopChild(proc, "SIGTERM");

    const exited = await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(5_000).then(() => false),
    ]);

    if (!exited) proc.kill("SIGKILL");
    await proc.exited;
  });

export const acquireServer = (
  options: ServerOptions
): Effect.Effect<OpenCodeServer, never, Scope.Scope> =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const stateDir = options.stateDir ?? paths().root;
    const stateFile = join(stateDir, "opencode-server.json");
    const passwordFile = join(stateDir, "opencode-server.password");
    const logFile = options.logFile ?? join(paths().logs, "opencode-server.log");
    const startTimeout = options.startTimeout ?? "30 seconds";
    let running: Running | null = null;

    const forget = () => {
      rmSync(stateFile, { force: true });
      rmSync(passwordFile, { force: true });
    };

    const start = Effect.gen(function* () {
      const opencodePath = options.opencodePath();

      if (opencodePath === null)
        return yield* opencodeError("opencode was not found on PATH; install OpenCode to use it");
      stopStale(stateFile);
      mkdirSync(stateDir, { recursive: true });
      mkdirSync(dirname(logFile), { recursive: true });
      const password = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
      writeFileSync(passwordFile, password, { mode: 0o600 });
      chmodSync(passwordFile, 0o600);

      const proc = Bun.spawn([opencodePath, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
        env: harnessEnv({ ...(options.env ?? process.env), OPENCODE_SERVER_PASSWORD: password }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: Bun.file(logFile),
      });

      const url = yield* Effect.tryPromise({
        try: () => readUrl(proc.stdout),
        catch: (cause) => opencodeError(`opencode serve didn't start: ${String(cause)}`, cause),
      }).pipe(
        Effect.timeoutOrElse({
          duration: startTimeout,
          orElse: () => Effect.fail(opencodeError("opencode serve didn't start in time")),
        }),
        Effect.tap((started) =>
          Effect.promise(() => unsupportedServer(started, password)).pipe(
            Effect.flatMap((reason) =>
              reason === null ? Effect.void : Effect.fail(opencodeError(reason))
            )
          )
        ),
        Effect.onError(() => Effect.andThen(stopProcess(proc), Effect.sync(forget)))
      );

      writeFileSync(stateFile, encodeState({ pid: proc.pid, url }));
      const entry: Running = { proc, handle: { url, password, opencodePath }, leases: 0 };

      void proc.exited.then(() => {
        if (running === entry) {
          running = null;
          forget();
        }
      });

      return entry;
    });

    const stop = Effect.suspend(() => {
      const entry = running;

      if (entry === null) return Effect.void;
      running = null;

      return Effect.andThen(stopProcess(entry.proc), Effect.sync(forget));
    });

    const acquire = lock.withPermits(1)(
      Effect.gen(function* () {
        running ??= yield* start;
        running.leases += 1;

        return running;
      })
    );

    const release = (entry: Running) =>
      lock.withPermits(1)(
        Effect.suspend(() => {
          entry.leases -= 1;

          return entry.leases === 0 && running === entry ? stop : Effect.void;
        })
      );

    yield* Effect.addFinalizer(() => lock.withPermits(1)(stop));

    return {
      lease: Effect.acquireRelease(acquire, release).pipe(Effect.map((entry) => entry.handle)),
      passwordFile,
      running: Effect.sync(() => running !== null),
    } satisfies OpenCodeServer;
  });
