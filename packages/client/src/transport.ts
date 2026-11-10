/**
 * Byte transports a Client connects over: a child process's stdio (normally
 * `ssh <alias> polaris bridge`) or the local Daemon's Unix socket.
 *
 * Each transport can explain, after it failed, why: `diagnose` classifies the
 * exit status and stderr into a ConnectFailure the Connection State uses.
 */
import { connect, type Socket } from "node:net";
import { Transform } from "node:stream";
import {
  type ByteTransport,
  FrameKind,
  MAX_FRAME_BYTES,
  readEvents,
  writeEvents,
} from "@polaris/protocol";
import { Deferred, Effect, Exit, Option, type Scope } from "effect";
import { ConnectFailure, classifyExit, type NeedsAttentionReason } from "./failures.ts";
import { encodeLines } from "./install/windows/powershell.ts";
import { localDaemonFailure } from "./localDaemon.ts";
import { type ChildProcessApi, childProcesses, spawnFailed } from "./process/index.ts";
import { connectOwnedPipe, isPipePath } from "./windowsPipe/index.ts";

export interface ClientTransport extends ByteTransport {
  /** Why the transport closed or failed; waits briefly for the process to exit. */
  readonly diagnose: Effect.Effect<ConnectFailure>;
}

/** How a HostConnection opens its transport. Injectable, so tests can replace `ssh`. */
export type Connector = Effect.Effect<ClientTransport, ConnectFailure, Scope.Scope>;

const STDERR_LIMIT = 16 * 1024;

const STDOUT_HEAD_LIMIT = 4 * 1024;

const decoder = new TextDecoder();

/** True when `head` can open a frame stream: a length within the limit, then a known kind. */
export const isFrameStart = (head: Uint8Array): boolean => {
  if (head.byteLength < 5) return false;
  const length = new DataView(head.buffer, head.byteOffset, 5).getUint32(0);
  const kind = head[4];

  return (
    length >= 1 && length <= MAX_FRAME_BYTES && (kind === FrameKind.Json || kind === FrameKind.Blob)
  );
};

export interface SpawnOptions {
  readonly env?: Record<string, string | undefined>;
  /** Grace period after stdin closes before the process is killed. */
  readonly killAfterMs?: number;
  /** Decodes stderr chunks and stdout's text; UTF-8 by default (wsl.exe mixes in UTF-16LE). */
  readonly stderrDecoder?: () => (chunk: Uint8Array) => string;
  /** Classifies the exit; `classifyExit` (ssh's messages) by default. */
  readonly classify?: (exit: {
    readonly code: number | null;
    readonly signal: string | null;
    readonly stderr: string;
    /** The start of stdout when it was text, not the wire (wsl.exe prints its errors there). */
    readonly stdout: string;
  }) => ConnectFailure;
  /** The reason when the command itself can't be spawned, from the Host's kind (`ssh-missing`). */
  readonly spawnFailureReason?: NeedsAttentionReason;
  /** Starts the process (`ChildProcess`); tests script or record it. */
  readonly processes?: ChildProcessApi;
  /**
   * Writes to stdin as base64 lines: a Windows Host's relay (`install/windows/`) reads them,
   * since its PowerShell reads stdin as text. What comes back is untouched.
   */
  readonly stdinLines?: boolean;
}

/** Every write as base64 lines, into `stdin`. */
const linesInto = (stdin: NodeJS.WritableStream) => {
  const lines = new Transform({
    transform(chunk: Uint8Array, _encoding, done) {
      done(null, encodeLines(chunk));
    },
  });

  lines.on("error", () => {});
  lines.pipe(stdin);

  return lines;
};

/** Runs `argv` and speaks the wire over its stdin/stdout. */
export const spawnTransport = (
  argv: ReadonlyArray<string>,
  options: SpawnOptions = {}
): Connector =>
  Effect.gen(function* () {
    const [command, ...args] = argv;

    if (command === undefined) {
      return yield* new ConnectFailure({
        kind: "needs-attention",
        reason: "command-missing",
        detail: "empty command",
      });
    }

    const exited = yield* Deferred.make<{ code: number | null; signal: string | null }>();
    const decode = options.stderrDecoder?.() ?? ((chunk: Uint8Array) => decoder.decode(chunk));
    const classify = options.classify ?? classifyExit;
    let stderr = "";
    const stdoutHead: Array<Uint8Array> = [];
    let stdoutHeadBytes = 0;
    let spawnError: NodeJS.ErrnoException | null = null;
    // Set from the child's `error` event; read through a call so TypeScript doesn't narrow it.
    const startError = () => spawnError;

    const stdoutText = (): string => {
      const head = Buffer.concat(stdoutHead);

      return head.byteLength === 0 || isFrameStart(head)
        ? ""
        : (options.stderrDecoder?.() ?? ((chunk: Uint8Array) => decoder.decode(chunk)))(head);
    };

    const { child, incoming } = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const child = (options.processes ?? childProcesses).spawn({
          file: command,
          args,
          stdio: ["pipe", "pipe", "pipe"],
          env: options.env ?? process.env,
        });

        child.on("error", (error: NodeJS.ErrnoException) => {
          spawnError = error;
          Deferred.doneUnsafe(exited, Exit.succeed({ code: null, signal: null }));
        });
        // `exit`, not `close`: an SSH ControlPersist master may keep stderr open for minutes.
        child.on("exit", (code, signal) =>
          Deferred.doneUnsafe(exited, Exit.succeed({ code, signal }))
        );
        child.stderr?.on("data", (chunk: Uint8Array) => {
          stderr = (stderr + decode(chunk)).slice(-STDERR_LIMIT);
        });
        child.stdin?.on("error", () => {});
        child.stdout?.on("data", (chunk: Uint8Array) => {
          if (stdoutHeadBytes >= STDOUT_HEAD_LIMIT) return;
          stdoutHead.push(chunk.subarray(0, STDOUT_HEAD_LIMIT - stdoutHeadBytes));
          stdoutHeadBytes += chunk.byteLength;
        });

        // Attach the reader now, before any output can arrive.
        const incoming = child.stdout === null ? null : readEvents(child.stdout);

        return { child, incoming };
      }),
      ({ child }) =>
        Effect.gen(function* () {
          child.stdin?.end();

          const done = yield* Deferred.await(exited).pipe(
            Effect.timeoutOption(options.killAfterMs ?? 2000)
          );

          if (Option.isNone(done)) child.kill("SIGTERM");
          child.stderr?.destroy();
          child.stdout?.destroy();
        })
    );

    const stdin =
      child.stdin !== null && options.stdinLines === true ? linesInto(child.stdin) : child.stdin;

    if (stdin === null || incoming === null) {
      return yield* new ConnectFailure({
        kind: "transient",
        reason: "spawn-failed",
        detail: "no stdio pipes",
      });
    }

    const missingReason = options.spawnFailureReason ?? "command-missing";

    // A spawn failure arrives on the next tick; wait for it so the attempt fails outright.
    yield* Effect.callback<void>((resume) => {
      setImmediate(() => resume(Effect.void));
    });

    const notStarted = startError();

    if (notStarted !== null) {
      return yield* new ConnectFailure({
        kind: "needs-attention",
        reason: missingReason,
        detail: `${command}: ${spawnFailed(command, notStarted).code}`,
      });
    }

    const diagnose = Deferred.await(exited).pipe(
      Effect.timeoutOption(3000),
      Effect.map((exit) => {
        const failed = startError();

        return failed !== null
          ? new ConnectFailure({
              kind: "needs-attention",
              reason: missingReason,
              detail: `${command}: ${spawnFailed(command, failed).code}`,
            })
          : classify({
              code: Option.isSome(exit) ? exit.value.code : null,
              signal: Option.isSome(exit) ? exit.value.signal : null,
              stderr,
              stdout: stdoutText(),
            });
      })
    );

    return {
      incoming,
      write: writeEvents(stdin),
      close: Effect.sync(() => {
        stdin.end();
      }),
      diagnose,
    } satisfies ClientTransport;
  });

type Opened = { readonly socket: Socket; readonly incoming: ByteTransport["incoming"] };

const connectSocket = (path: string, installedHome?: string) =>
  Effect.callback<Opened, ConnectFailure>((resume) => {
    const socket = connect(path);

    const onError = (error: NodeJS.ErrnoException) =>
      resume(
        Effect.fail(
          error.code === "ENOENT" || error.code === "ECONNREFUSED"
            ? localDaemonFailure(path, installedHome)
            : new ConnectFailure({
                kind: "transient",
                reason: "connection-failed",
                detail: `${path}: ${error.code ?? error.message}`,
              })
        )
      );

    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      socket.on("error", () => {});
      resume(Effect.succeed({ socket, incoming: readEvents(socket) }));
    });
  });

/**
 * Whether the pipe's owner is checked before the first byte: on Windows under Node (the
 * Desktop App). Bun can't adopt a handle as a socket, so its tools connect as before (ADR 0062).
 */
export const checksPipeOwner = (
  path: string,
  platform: string = process.platform,
  bun: boolean = process.versions.bun !== undefined
): boolean => platform === "win32" && isPipePath(path) && !bun;

const openLocal = (path: string, installedHome?: string): Effect.Effect<Opened, ConnectFailure> =>
  checksPipeOwner(path)
    ? Effect.map(connectOwnedPipe(path, installedHome), (socket) => {
        socket.on("error", () => {});

        return { socket, incoming: readEvents(socket) };
      })
    : connectSocket(path, installedHome);

/**
 * Connects straight to a Daemon's Unix socket or Windows pipe (the local Host). With
 * `installedHome`, a refusal says whether a Daemon is installed there and what its log says.
 */
export const socketTransport = (path: string, installedHome?: string): Connector =>
  Effect.gen(function* () {
    const { socket, incoming } = yield* Effect.acquireRelease(
      openLocal(path, installedHome),
      ({ socket }) => Effect.sync(() => socket.destroy())
    );

    return {
      incoming,
      write: writeEvents(socket),
      close: Effect.sync(() => {
        socket.end();
      }),
      diagnose: Effect.succeed(
        new ConnectFailure({
          kind: "transient",
          reason: "connection-lost",
          detail: `the Daemon closed ${path}`,
        })
      ),
    } satisfies ClientTransport;
  });
