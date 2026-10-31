/**
 * Terminals on the Host, through `Bun.Terminal` (never node-pty). A terminal
 * belongs to the Daemon, not to a Client: it outlives Client disconnects, any
 * number of Clients can attach at once, and a late attacher first gets the
 * recent scrollback replayed.
 *
 * Across a Daemon restart:
 * - **execve upgrade**: terminals keep running. Before the exec, each PTY
 *   master fd is kept open (close-on-exec cleared) and the shells stay our
 *   children (same PID). The new image re-adopts the master fd (read with
 *   `Bun.file(fd).stream()`, written with `writeSync`, resized with `stty` on
 *   the slave side) and reaps the shell itself. Scrollback and exit states
 *   travel in `~/.polaris/terminals-handoff.json`.
 * - **crash, service restart, reboot**: the PTY master closes with the
 *   process, so the shells get SIGHUP and the terminals end. Every open
 *   terminal is recorded in `~/.polaris/terminals.json`; the next Daemon
 *   lists those as ended (`endedBy: "daemon-restart"`), so a Client that
 *   re-attaches gets `Exit { code: null }` instead of NotFound, and can open
 *   a new terminal in the same `cwd`.
 */
import { childEnv, repositoryEnv } from "../service/childEnv.ts";
import { TraceRuntime } from "../traces/runtime.ts";
import { traceEndpointEnvironment } from "../traces/environment.ts";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FileError, NotFound, TerminalAttach, TerminalId } from "@polaris/protocol";
import { Context, Effect, Layer, Option, Predicate, Queue, Schema, Stream } from "effect";
import { resolveHostPath, toFsFailure } from "../files/fs.ts";
import { paths } from "../paths.ts";
import * as libc from "../service/libc.ts";
import { registerHandoffContributor, takeHandoff } from "../service/upgrade.ts";
import { executableOf } from "../platform/executable.ts";
import { killTree, killTreeSync } from "../platform/processes.ts";
import { defaultShellArgv, programIn } from "./shell.ts";

/** Scrollback kept per terminal for replay to late attachers. */
export const SCROLLBACK_BYTES = 256 * 1024;

/** After the process exits, how long to wait for the PTY to drain before reporting Exit. */
const DRAIN_AFTER_EXIT_MS = 200;

/** How often an adopted shell (not known to Bun) is checked for exit. */
const REAP_INTERVAL_MS = 200;

/**
 * PTY reads are small (often 1 KiB or less), and each one sent on its own
 * costs far more than its bytes. Output is gathered for up to
 * OUTPUT_FLUSH_MS (well under a 120 Hz frame) or until OUTPUT_FLUSH_BYTES
 * have piled up, then goes to the scrollback and every attacher as one chunk.
 */
export const OUTPUT_FLUSH_MS = 4;

export const OUTPUT_FLUSH_BYTES = 64 * 1024;

/** What an attacher receives: `terminal.attach`'s items, with their `cases` constructors. */
export const TerminalItem = TerminalAttach.successSchema.success;

export type TerminalItem = typeof TerminalItem.Type;

export type TerminalOutput = typeof TerminalItem.cases.Output.Type;

/** A byte ring buffer of whole chunks, trimmed from the front to `capacity`. */
export class Scrollback {
  private chunks: Array<Uint8Array> = [];
  private size = 0;
  constructor(readonly capacity: number) {}

  push(chunk: Uint8Array): void {
    if (chunk.byteLength >= this.capacity) {
      this.chunks = [chunk.slice(chunk.byteLength - this.capacity)];
      this.size = this.capacity;

      return;
    }

    this.chunks.push(chunk);
    this.size += chunk.byteLength;

    while (this.size > this.capacity) {
      const first = this.chunks[0]!;
      const excess = this.size - this.capacity;

      if (first.byteLength <= excess) {
        this.chunks.shift();
        this.size -= first.byteLength;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
    }
  }

  snapshot(): Uint8Array {
    const out = new Uint8Array(this.size);
    let at = 0;

    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }

    return out;
  }

  get byteLength(): number {
    return this.size;
  }
}

export interface TerminalInfo {
  readonly id: TerminalId;
  readonly cwd: string;
  readonly argv: ReadonlyArray<string>;
  readonly pid: number;
  /** Null while running. */
  readonly exit: { readonly code: number | null } | null;
  /** Why it ended: its process exited, or the Daemon restarted (crash, service restart, reboot). */
  readonly endedBy: "exit" | "daemon-restart" | null;
}

/** The PTY side of a terminal: Bun's own, or a master fd adopted across an upgrade. */
interface Pty {
  readonly write: (data: Uint8Array) => void;
  readonly resize: (cols: number, rows: number) => void;
  readonly close: () => void;
}

interface Live {
  readonly info: Omit<TerminalInfo, "exit" | "endedBy">;
  pty: Pty | null;
  /** The PTY master fd, when known; what an upgrade hands over. */
  masterFd: number | null;
  /** The slave device (`/dev/pts/3`), for resizing an adopted PTY. */
  slave: string | null;
  cols: number;
  rows: number;
  readonly scrollback: Scrollback;
  readonly listeners: Set<(item: TerminalItem) => void>;
  exit: { readonly code: number | null } | null;
  endedBy: TerminalInfo["endedBy"];
  /** Output not flushed yet (see OUTPUT_FLUSH_MS). */
  readonly pending: PendingOutput;
}

interface PendingOutput {
  buffer: Uint8Array;
  length: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Where a spawned PTY's output goes: set once its `Live` exists. */
interface OutputTarget {
  live: Live | undefined;
}

const pendingOutput = (): PendingOutput => ({
  buffer: new Uint8Array(OUTPUT_FLUSH_BYTES),
  length: 0,
  timer: null,
});

/** Whose environment a terminal starts with: the user's, or the allowlist for repository code. */
export type TerminalEnvironment = "user" | "repository";

export class Terminals extends Context.Service<
  Terminals,
  {
    /** Starts the user's login shell (or `argv`) in `cwd`. */
    readonly open: (options: {
      readonly cwd: string;
      readonly cols: number;
      readonly rows: number;
      readonly argv: ReadonlyArray<string> | null;
      /** `repository` starts it with `repositoryEnv`; the user's environment by default. */
      readonly environment?: TerminalEnvironment;
    }) => Effect.Effect<TerminalId, FileError>;
    /** Scrollback first, then live output; ends after `Exit`. */
    readonly attach: (id: TerminalId) => Stream.Stream<TerminalItem, NotFound>;
    readonly input: (id: TerminalId, data: Uint8Array) => Effect.Effect<void, NotFound>;
    readonly resize: (id: TerminalId, cols: number, rows: number) => Effect.Effect<void, NotFound>;
    /** Hangs up the process (SIGHUP, as closing a terminal window does) and forgets the terminal. */
    readonly close: (id: TerminalId) => Effect.Effect<void, NotFound>;
    readonly list: Effect.Effect<ReadonlyArray<TerminalInfo>>;
  }
>()("polaris/daemon/terminal/Terminals") {}

/**
 * On macOS the command waits on fd 3 until `Bun.spawn` has returned, so it
 * can't exit before Bun watches it: see ADR 0052 (a deadlock otherwise).
 */
const SPAWN_GATE = ["/bin/sh", "-c", 'read -r _ <&3; exec 3<&-; exec "$0" "$@"'];

const gateSpawns = process.platform === "darwin";

/**
 * Windows: ConPTY takes no fd past stdio, PTY fds can't be handed across an
 * upgrade (there are none), and closing the console leaves the shell's children running.
 */
const windows = process.platform === "win32";

/** A terminal's stdio: fd 3 is the macOS gate; Windows refuses any fd past 2 with a terminal. */
const spawnStdio = (): ["ignore", "ignore", "ignore", ...Array<"ignore" | "pipe">] =>
  windows
    ? ["ignore", "ignore", "ignore"]
    : ["ignore", "ignore", "ignore", gateSpawns ? "pipe" : "ignore"];

/** Lets a gated command run; it may already be gone (EPIPE). */
const openGate = (fd: number | null | undefined) => {
  try {
    if (fd !== undefined && fd !== null) writeSync(fd, "\n");
  } catch {}
};

const clampSize = (n: number, fallback: number) =>
  Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 10_000) : fallback;

// ── Persistence ────────────────────────────────────────────────────────────

/** A terminal as recorded on disk (`terminals.json`), so the next Daemon knows it ended. */
const TerminalRecord = Schema.Struct({
  id: TerminalId,
  cwd: Schema.String,
  argv: Schema.Array(Schema.String),
  pid: Schema.Int,
});

/** A terminal handed across an execve upgrade (`terminals-handoff.json`). */
const HandedTerminal = Schema.Struct({
  ...TerminalRecord.fields,
  cols: Schema.Int,
  rows: Schema.Int,
  slave: Schema.NullOr(Schema.String),
  exit: Schema.NullOr(Schema.Struct({ code: Schema.NullOr(Schema.Int) })),
  endedBy: Schema.NullOr(Schema.Literals(["exit", "daemon-restart"])),
  /** Base64 of the scrollback. */
  scrollback: Schema.String,
});

const decodeRecords = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(TerminalRecord))
);

const decodeHanded = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(HandedTerminal))
);

type TerminalRecord = typeof TerminalRecord.Type;

type HandedTerminal = typeof HandedTerminal.Type;

const readJson = <A>(path: string, decode: (raw: string) => Option.Option<A>): A | null => {
  try {
    return Option.getOrNull(decode(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
};

/** Handed terminals are records too, so both files go through here. */
const writeJsonAtomic = (path: string, value: ReadonlyArray<TerminalRecord>) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, path);
};

const handoffName = (id: string) => `terminal:${id}`;

export interface TerminalsOptions {
  /**
   * Where `terminals.json` and `terminals-handoff.json` live. Null keeps
   * terminals in memory only (tests), and then nothing is handed across an
   * upgrade either.
   */
  readonly stateDir: string | null;
}

// ── PTY backends ───────────────────────────────────────────────────────────

/**
 * Finds the PTY master fd Bun opened for a terminal: the lowest fd that was
 * not open before the spawn and has a slave device. Bun keeps a few dups of
 * the master; any one will do, the others close on exec.
 */
const findMaster = (before: ReadonlySet<number>): { fd: number; slave: string } | null => {
  for (const fd of libc.openFds()) {
    if (before.has(fd)) continue;
    const slave = libc.ptsname(fd);

    if (slave !== null) return { fd, slave };
  }

  return null;
};

const openFdsOrNull = (): Set<number> | null => {
  try {
    return new Set(libc.openFds());
  } catch {
    return null;
  }
};

/** A write to a non-blocking fd that would block: retry later. */
const isAgain = Schema.is(Schema.Struct({ code: Schema.Literals(["EAGAIN", "EWOULDBLOCK"]) }));

/**
 * A PTY master fd inherited across an execve. Bun opened it non-blocking, so
 * writes that would block are queued and retried; reads go through Bun's own
 * file reader, which waits for readiness. `stty` on the slave device resizes
 * it (`ioctl(TIOCSWINSZ)` is variadic, which bun:ffi can't call portably).
 */
const adoptPty = (options: {
  readonly fd: number;
  readonly slave: string | null;
  readonly onData: (chunk: Uint8Array) => void;
  readonly onClosed: () => void;
}): Pty => {
  let closed = false;
  const pending: Array<Uint8Array> = [];
  let flushing: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    flushing = null;

    while (!closed && pending.length > 0) {
      const chunk = pending[0]!;

      try {
        const written = writeSync(options.fd, chunk);

        if (written < chunk.byteLength) pending[0] = chunk.subarray(written);
        else pending.shift();
      } catch (error) {
        if (isAgain(error)) {
          flushing = setTimeout(flush, 10);

          return;
        }

        pending.length = 0;
      }
    }
  };

  void (async () => {
    try {
      for await (const chunk of Bun.file(options.fd).stream())
        options.onData(new Uint8Array(chunk));
    } catch {
      // EIO on Linux once the slave side is gone: the PTY's end of file.
    }

    options.onClosed();
  })();

  return {
    write: (data) => {
      if (closed) return;
      pending.push(data);

      if (flushing === null) flush();
    },
    resize: (cols, rows) => {
      if (closed || options.slave === null) return;
      const flag = process.platform === "darwin" ? "-f" : "-F";
      Bun.spawn(
        [executableOf("stty"), flag, options.slave, "cols", String(cols), "rows", String(rows)],
        {
          env: childEnv(),
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }
      );
    },
    close: () => {
      if (closed) return;
      closed = true;

      if (flushing !== null) clearTimeout(flushing);

      try {
        libc.closeFd(options.fd);
      } catch {}
    },
  };
};

// ── Start-up ───────────────────────────────────────────────────────────────

/** A terminal an upgrade handed over, with its scrollback; its PTY is adopted separately. */
const liveFromHanded = (record: HandedTerminal): Live => {
  const scrollback = new Scrollback(SCROLLBACK_BYTES);
  const replay = Buffer.from(record.scrollback, "base64");

  if (replay.byteLength > 0) scrollback.push(new Uint8Array(replay));

  return {
    info: { id: record.id, cwd: record.cwd, argv: record.argv, pid: record.pid },
    pty: null,
    masterFd: null,
    slave: record.slave,
    cols: record.cols,
    rows: record.rows,
    scrollback,
    listeners: new Set(),
    exit: record.exit,
    endedBy: record.endedBy,
    pending: pendingOutput(),
  };
};

/** A terminal the previous Daemon recorded as running: a crash or restart ended it. */
const endedLive = (record: TerminalRecord): Live => ({
  info: { id: record.id, cwd: record.cwd, argv: record.argv, pid: record.pid },
  pty: null,
  masterFd: null,
  slave: null,
  cols: 80,
  rows: 24,
  scrollback: new Scrollback(SCROLLBACK_BYTES),
  listeners: new Set(),
  exit: { code: null },
  endedBy: "daemon-restart",
  pending: pendingOutput(),
});

// ── The service ────────────────────────────────────────────────────────────

export const makeTerminalsWith = (options: TerminalsOptions) =>
  Effect.gen(function* () {
    const traces = yield* Effect.serviceOption(TraceRuntime);
    const terminals = new Map<string, Live>();
    const recordsFile = options.stateDir === null ? null : join(options.stateDir, "terminals.json");

    const handoffFile =
      options.stateDir === null ? null : join(options.stateDir, "terminals-handoff.json");

    /** Record running terminals, so the next Daemon knows which ones a crash ended. */
    const persist = () => {
      if (recordsFile === null) return;

      const running = [...terminals.values()].flatMap((live) =>
        live.exit === null ? [{ ...live.info, argv: [...live.info.argv] }] : []
      );

      try {
        writeJsonAtomic(recordsFile, running);
      } catch {
        // Best effort: an unwritable home must not break terminals.
      }
    };

    const notFound = (id: string) => new NotFound({ what: "terminal", id });

    const lookup = (id: TerminalId) =>
      Effect.suspend(() => {
        const live = terminals.get(id);

        return live === undefined ? Effect.fail(notFound(id)) : Effect.succeed(live);
      });

    const broadcast = (live: Live, item: TerminalItem) => {
      for (const listener of live.listeners) listener(item);
    };

    /** Sends the gathered output: to the scrollback and every attacher, as one chunk. */
    const flush = (live: Live) => {
      const pending = live.pending;

      if (pending.timer !== null) {
        clearTimeout(pending.timer);
        pending.timer = null;
      }

      if (pending.length === 0) return;
      let chunk: Uint8Array;

      if (pending.length === pending.buffer.byteLength) {
        chunk = pending.buffer;
        pending.buffer = new Uint8Array(OUTPUT_FLUSH_BYTES);
      } else {
        chunk = pending.buffer.slice(0, pending.length);
      }

      pending.length = 0;
      live.scrollback.push(chunk);
      broadcast(live, TerminalItem.cases.Output.make({ data: chunk }));
    };

    /** Gathers PTY output; copies it, so the caller's buffer may be reused. */
    const output = (live: Live, data: Uint8Array) => {
      if (live.exit !== null) return;
      const pending = live.pending;

      for (let at = 0; at < data.byteLength;) {
        const n = Math.min(data.byteLength - at, pending.buffer.byteLength - pending.length);
        pending.buffer.set(data.subarray(at, at + n), pending.length);
        pending.length += n;
        at += n;

        if (pending.length === pending.buffer.byteLength) flush(live);
      }

      if (pending.length > 0 && pending.timer === null) {
        pending.timer = setTimeout(() => flush(live), OUTPUT_FLUSH_MS);
      }
    };

    const finish = (live: Live, code: number | null, endedBy: TerminalInfo["endedBy"] = "exit") => {
      if (live.exit !== null) return;
      flush(live);
      live.exit = { code };
      live.endedBy = endedBy;
      broadcast(live, TerminalItem.cases.Exit.make({ code }));
      live.listeners.clear();
      persist();
    };

    /** SIGHUP, as closing a terminal window does; on Windows the whole tree, unless `ended` already. */
    const kill = (live: Live, ended = false) => {
      if (live.exit === null && !ended) {
        if (windows) killTreeSync(live.info.pid);
        else {
          try {
            process.kill(live.info.pid, "SIGHUP");
          } catch {
            // Already gone.
          }
        }
      }

      live.pty?.close();
      live.pty = null;
      live.masterFd = null;
    };

    // Watches an adopted shell, which the new image's Bun doesn't know about.
    const reapers = new Set<ReturnType<typeof setInterval>>();

    const watchAdopted = (live: Live) => {
      const timer = setInterval(() => {
        let status: number | null;

        try {
          status = libc.reapChild(live.info.pid);
        } catch {
          status = -1; // ECHILD: someone else reaped it; the code is lost.
        }

        if (status === null) return;
        clearInterval(timer);
        reapers.delete(timer);
        const code = status === -1 ? null : libc.exitCodeOf(status);
        setTimeout(() => finish(live, code), DRAIN_AFTER_EXIT_MS);
      }, REAP_INTERVAL_MS);

      reapers.add(timer);
    };

    // ── Start-up: adopt what an upgrade handed over, or mark what a crash ended.
    const handoff =
      options.stateDir === null
        ? null
        : yield* takeHandoff().pipe(Effect.orElseSucceed(() => null));

    const handed =
      handoff !== null && handoffFile !== null ? readJson(handoffFile, decodeHanded) : null;

    if (handoffFile !== null) rmSync(handoffFile, { force: true });

    /** Re-adopts a handed terminal's PTY master fd, or ends it when none came across. */
    const adopt = (live: Live, fd: number | undefined) => {
      if (live.exit !== null) return;

      if (fd === undefined) {
        finish(live, null, "daemon-restart");

        return;
      }

      live.masterFd = fd;
      live.pty = adoptPty({
        fd,
        slave: live.slave,
        onData: (chunk) => output(live, chunk),
        onClosed: () => {},
      });
      watchAdopted(live);
    };

    if (handed !== null && handoff !== null) {
      for (const record of handed) {
        const live = liveFromHanded(record);
        terminals.set(record.id, live);
        adopt(live, handoff.fds[handoffName(record.id)]);
      }
    } else if (recordsFile !== null) {
      for (const record of readJson(recordsFile, decodeRecords) ?? []) {
        terminals.set(record.id, endedLive(record));
      }
    }

    persist();

    // ── Upgrade hand-off: keep every master fd and shell, write the rest to disk.
    if (handoffFile !== null) {
      yield* registerHandoffContributor({
        name: "terminals",
        collect: () =>
          Effect.sync(() => {
            const fds: Record<string, number> = {};
            const children: Record<string, number> = {};

            for (const live of terminals.values()) {
              if (live.exit !== null || live.masterFd === null) continue;
              fds[handoffName(live.info.id)] = live.masterFd;
              children[handoffName(live.info.id)] = live.info.pid;
            }

            return { fds, children };
          }),
        beforeExec: Effect.sync(() => {
          for (const live of terminals.values()) flush(live);
          writeJsonAtomic(
            handoffFile,
            [...terminals.values()].map((live) => ({
              ...live.info,
              argv: [...live.info.argv],
              cols: live.cols,
              rows: live.rows,
              slave: live.slave,
              exit: live.exit,
              endedBy: live.endedBy,
              scrollback: Buffer.from(live.scrollback.snapshot()).toString("base64"),
            }))
          );
        }),
        abort: Effect.sync(() => rmSync(handoffFile, { force: true })),
      });
    }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const timer of reapers) clearInterval(timer);

        for (const live of terminals.values()) {
          if (live.pending.timer !== null) clearTimeout(live.pending.timer);
          kill(live);
        }

        terminals.clear();

        // A clean shutdown ended every terminal itself; nothing to report next time.
        if (recordsFile !== null && existsSync(recordsFile)) rmSync(recordsFile, { force: true });
      })
    );

    const open = Effect.fn("Terminals.open")(function* (openOptions: {
      readonly cwd: string;
      readonly cols: number;
      readonly rows: number;
      readonly argv: ReadonlyArray<string> | null;
      readonly environment?: TerminalEnvironment;
    }) {
      const cwd = resolveHostPath(openOptions.cwd);
      yield* Effect.tryPromise({
        try: async () => {
          const stats = await stat(cwd);

          if (!stats.isDirectory()) {
            throw Object.assign(new Error(`not a directory: ${cwd}`), { code: "ENOTDIR" });
          }
        },
        catch: (cause) => {
          const failure = toFsFailure(cwd, cause);

          return new FileError({ path: cwd, code: failure.code, message: failure.message });
        },
      });

      const argv =
        openOptions.argv !== null && openOptions.argv.length > 0
          ? [...openOptions.argv]
          : defaultShellArgv();

      const id = TerminalId.make(`term_${randomUUID()}`);
      const cols = clampSize(openOptions.cols, 80);
      const rows = clampSize(openOptions.rows, 24);
      const target: OutputTarget = { live: undefined };

      const traceEnv = Option.isSome(traces)
        ? yield* traces.value
            .terminalEnvironment(cwd, process.env)
            .pipe(Effect.orElseSucceed(() => ({})))
        : {};

      const spawned = yield* Effect.try({
        try: () => {
          // Synchronous from here to findMaster: no other fd can appear in between.
          const colors = { TERM: "xterm-256color", COLORTERM: "truecolor" };

          const env =
            openOptions.environment === "repository"
              ? repositoryEnv(process.env, {
                  ...colors,
                  ...traceEndpointEnvironment(process.env),
                  ...traceEnv,
                })
              : childEnv({ ...process.env, ...colors, ...traceEnv });

          // By its absolute path; the gate's sh would report a missing one only in the terminal.
          const program = programIn(cwd, argv[0]!, env);

          if (program === null)
            throw Object.assign(new Error(`no such command: ${argv[0]}`), { code: "ENOENT" });
          const command = [program, ...argv.slice(1)];
          const before = handoffFile === null || windows ? null : openFdsOrNull();

          const proc = Bun.spawn(gateSpawns ? [...SPAWN_GATE, ...command] : command, {
            cwd,
            env,
            stdio: spawnStdio(),
            terminal: {
              cols,
              rows,
              name: "xterm-256color",
              data: (_terminal, data) => {
                if (target.live !== undefined) {
                  output(target.live, data instanceof Uint8Array ? data : new Uint8Array(data));
                }
              },
            },
          });

          let master: { fd: number; slave: string } | null = null;

          try {
            master = before === null ? null : findMaster(before);
          } catch {}

          if (gateSpawns) openGate(proc.stdio[3]);

          return { proc, master };
        },
        catch: (cause) =>
          new FileError({
            path: argv[0] ?? cwd,
            code: toFsFailure(cwd, cause).code,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });

      const terminal = spawned.proc.terminal!;

      const live: Live = {
        info: { id, cwd, argv, pid: spawned.proc.pid },
        pty: {
          write: (data) => {
            if (!terminal.closed) terminal.write(data);
          },
          resize: (c, r) => {
            if (!terminal.closed) terminal.resize(c, r);
          },
          close: () => terminal.close(),
        },
        masterFd: spawned.master?.fd ?? null,
        slave: spawned.master?.slave ?? null,
        cols,
        rows,
        scrollback: new Scrollback(SCROLLBACK_BYTES),
        listeners: new Set(),
        exit: null,
        endedBy: null,
        pending: pendingOutput(),
      };

      target.live = live;
      terminals.set(id, live);
      persist();
      void spawned.proc.exited.then(() => {
        // Let the PTY drain the last output before reporting the exit.
        setTimeout(() => finish(live, spawned.proc.exitCode), DRAIN_AFTER_EXIT_MS);
      });

      return id;
    });

    const attach = (id: TerminalId): Stream.Stream<TerminalItem, NotFound> =>
      Stream.callback<TerminalItem, NotFound>((queue) =>
        Effect.gen(function* () {
          const live = yield* lookup(id);
          // Synchronous: no output can slip between the replay and the subscription.
          const replay = live.scrollback.snapshot();

          if (replay.byteLength > 0)
            Queue.offerUnsafe(queue, TerminalItem.cases.Output.make({ data: replay }));

          if (live.exit !== null) {
            Queue.offerUnsafe(queue, TerminalItem.cases.Exit.make({ code: live.exit.code }));
            Queue.endUnsafe(queue);

            return;
          }

          const listener = (item: TerminalItem) => {
            Queue.offerUnsafe(queue, item);

            if (Predicate.isTagged(item, "Exit")) Queue.endUnsafe(queue);
          };

          live.listeners.add(listener);
          yield* Effect.addFinalizer(() => Effect.sync(() => live.listeners.delete(listener)));
        })
      );

    return Terminals.of({
      open,
      attach,
      input: (id, data) =>
        Effect.flatMap(lookup(id), (live) => Effect.sync(() => live.pty?.write(data))),
      resize: (id, cols, rows) =>
        Effect.flatMap(lookup(id), (live) =>
          Effect.sync(() => {
            live.cols = clampSize(cols, 80);
            live.rows = clampSize(rows, 24);
            live.pty?.resize(live.cols, live.rows);
          })
        ),
      close: (id) =>
        Effect.flatMap(lookup(id), (live) => {
          const end = () => {
            kill(live, windows);
            finish(live, null, live.endedBy ?? "exit");
            persist();
          };

          terminals.delete(id);

          // taskkill finds the children through the shell, so it runs before the console closes.
          return windows && live.exit === null
            ? Effect.promise(() => killTree(live.info.pid)).pipe(Effect.andThen(Effect.sync(end)))
            : Effect.sync(end);
        }),
      list: Effect.sync(() =>
        [...terminals.values()].map((live) => ({
          ...live.info,
          exit: live.exit,
          endedBy: live.endedBy,
        }))
      ),
    });
  });

/** In-memory terminals, killed when this layer's scope closes. For tests and embedding. */
export const makeTerminals = makeTerminalsWith({ stateDir: null });

export const TerminalsLive = Layer.effect(Terminals, makeTerminals);

/**
 * The Daemon's terminals: recorded under `~/.polaris/` so a restart reports
 * them as ended, and handed across execve upgrades.
 */
export const TerminalsDaemonLive = Layer.effect(
  Terminals,
  Effect.suspend(() => makeTerminalsWith({ stateDir: paths().root }))
);
