/**
 * In-place Daemon upgrade by `execve` hand-off (the tty7 pattern, as in the
 * Codex auto-upgrade). The running Daemon validates the new binary, clears
 * close-on-exec on the fds it wants to keep, and `execve`s into the new
 * binary in the same PID. Harness child processes stay its children, the
 * listening socket stays open, and the event store reloads from SQLite.
 *
 * What Bun can and cannot do here (proven by upgrade.slow.test.ts on macOS):
 * - `listener.fd` exposes the fd of a `Bun.listen` (and `node:net`) listener.
 * - Neither `Bun.listen({ fd })` nor `net.Server#listen({ fd })` can adopt an
 *   inherited listener ("Bun does not support listening on a file
 *   descriptor"). So the new image binds a fresh listener at a temporary
 *   path, renames it over the socket path (atomic), then drains connections
 *   already queued on the inherited listener with `accept(2)` and closes it.
 *   No connection attempt is refused during the hand-off.
 * - `Bun.connect({ fd })` wraps an accepted or inherited connected socket fd;
 *   `new net.Socket({ fd })` does not work in Bun.
 * - `Bun.spawn` does not expose its pipe fds, so a Harness whose process
 *   should survive an upgrade must be spawned with a socketpair as its stdio
 *   (`socketPair()` in libc.ts); the fd is handed off and re-wrapped with
 *   `Bun.connect({ fd })`. Adopted children must be reaped with `reapChild`.
 *
 * Wire-up (transport workstream):
 *
 *   // startup
 *   const adopted = yield* adoptListener()             // null on a cold start
 *   const server = yield* bindAtomically(paths().socket, (tmp) => listen(tmp))
 *   if (adopted) yield* adopted.drain((fd) => Bun.connect({ fd, socket: handlers }))
 *   yield* serveUpgrades({ listenerFd: () => server.fd })
 *
 * Existing Client connections are not handed off: they close on exec and the
 * Client resumes with `afterSequence`, as after any reconnect.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FdSocketOptions, Socket, SocketHandler, SocketListener } from "bun";
import { Effect, Schema } from "effect";
import { paths } from "../paths.ts";
import { CommandRunner } from "./CommandRunner.ts";
import * as libc from "./libc.ts";
import { parseVersionLine, runtimePlatform, VERSION } from "./platform.ts";

export class UpgradeError extends Schema.TaggedError<UpgradeError>()("UpgradeError", {
  step: Schema.String,
  message: Schema.String,
}) {}

/** Environment variable carrying the hand-off envelope into the new image. */
export const HANDOFF_ENV = "POLARIS_HANDOFF";

export const Handoff = Schema.Struct({
  /** Same PID across execve; absent on envelopes produced by older Daemons. */
  ownerPid: Schema.optional(Schema.Int),
  /** The inherited listening socket, or null if the Daemon had none. */
  listenerFd: Schema.NullOr(Schema.Int),
  /** Other inherited fds by name, e.g. `harness:<sessionId>` for a Harness's socketpair stdio. */
  fds: Schema.Record(Schema.String, Schema.Int),
  /** Child processes that are now this process's children, by name. */
  children: Schema.Record(Schema.String, Schema.Int),
  fromVersion: Schema.String,
  requestId: Schema.NullOr(Schema.String),
});

export type Handoff = typeof Handoff.Type;

declare module "bun" {
  /** `Bun.connect({ fd })` works at runtime; Bun's declarations only lack the overload. */
  function connect<Data = undefined>(options: FdSocketOptions<Data>): Promise<Socket<Data>>;
}

const fail = (step: string) => (cause: unknown) =>
  new UpgradeError({ step, message: cause instanceof Error ? cause.message : String(cause) });

// ── Before exec (old image) ────────────────────────────────────────────────

export interface HandoffExtras {
  readonly fds?: Readonly<Record<string, number>>;
  readonly children?: Readonly<Record<string, number>>;
  readonly requestId?: string | null;
}

/**
 * Clear close-on-exec on the listener and every extra fd, and return the
 * environment the new image needs to adopt them. Call immediately before
 * `execInto`; if the exec does not happen, call `abortHandoff` with the same
 * fds so they do not leak into later children.
 */
export const prepareHandoff = Effect.fn("prepareHandoff")(function* (
  listenerFd: number | null,
  extras: HandoffExtras = {}
) {
  const fds = extras.fds ?? {};
  const all = [...(listenerFd === null ? [] : [listenerFd]), ...Object.values(fds)];
  yield* Effect.try({
    try: () => {
      for (const fd of all) libc.clearCloseOnExec(fd);
    },
    catch: fail("clear close-on-exec"),
  });

  const handoff: Handoff = {
    ownerPid: process.pid,
    listenerFd,
    fds: { ...fds },
    children: { ...extras.children },
    fromVersion: VERSION,
    requestId: extras.requestId ?? null,
  };

  return { [HANDOFF_ENV]: JSON.stringify(handoff) };
});

/** Undo `prepareHandoff` after a failed exec. */
export const abortHandoff = (fds: ReadonlyArray<number>) =>
  Effect.sync(() => {
    for (const fd of fds) {
      try {
        libc.setCloseOnExec(fd);
      } catch {}
    }
  });

/**
 * Replace this process with `binary`, same PID. `env` is merged over the
 * current environment. Only returns by failing.
 */
export const execInto = Effect.fn("execInto")(function* (options: {
  readonly binary: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
}) {
  return yield* Effect.try({
    try: () =>
      libc.execve(options.binary, [options.binary, ...options.args], {
        ...process.env,
        ...options.env,
      }),
    catch: fail("execve"),
  });
});

// ── After exec (new image) ─────────────────────────────────────────────────

let taken: Handoff | null | undefined;

const validateHandoff = (handoff: Handoff): Handoff => {
  if (handoff.ownerPid !== undefined && handoff.ownerPid !== process.pid)
    throw new Error("hand-off belongs to another process");

  const fds = [
    ...(handoff.listenerFd === null ? [] : [handoff.listenerFd]),
    ...Object.values(handoff.fds),
  ];

  for (const fd of fds) {
    const closeOnExec = libc.isCloseOnExec(fd);

    // Linux Bun sets this flag during startup; validate the inherited resource instead (ADR-0023).
    if (fd < 3 || fd > 0x7fff_ffff || (process.platform !== "linux" && closeOnExec))
      throw new Error(`fd ${fd} was not inherited across execve`);
  }

  if (handoff.listenerFd !== null && !libc.isListeningSocket(handoff.listenerFd))
    throw new Error("hand-off listener is not a listening socket");

  for (const fd of Object.values(handoff.fds)) {
    if (!libc.isStreamSocket(fd) && libc.ptsname(fd) === null)
      throw new Error("hand-off child descriptor is not a stream socket or PTY");
  }

  for (const fd of fds) libc.setCloseOnExec(fd);

  return handoff;
};

/**
 * Read (once) and remove the hand-off envelope from the environment, so it
 * is not passed on to Harnesses or terminals. Null on a cold start.
 */
export const takeHandoff = Effect.fn("takeHandoff")(function* () {
  if (taken !== undefined) return taken;
  const raw = process.env[HANDOFF_ENV];
  delete process.env[HANDOFF_ENV];

  if (raw === undefined) {
    taken = null;

    return taken;
  }

  taken = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Handoff))(raw).pipe(
    Effect.mapError(fail("read hand-off")),
    Effect.flatMap((handoff) =>
      Effect.try({
        try: () => validateHandoff(handoff),
        catch: fail("validate hand-off"),
      })
    ),
    Effect.catch((error) =>
      Effect.as(Effect.logWarning("ignoring an invalid upgrade hand-off", error), null)
    )
  );

  return taken;
});

export interface AdoptedListener {
  readonly fd: number;
  readonly fromVersion: string;
  /**
   * Accept every connection queued on the inherited listener, plus any that
   * arrive within `graceMs` (clients that resolved the socket path before the
   * rename), hand each connected fd to `onConnection` (wrap it with
   * `Bun.connect({ fd, socket })`), then close the inherited listener.
   * Call after the new listener is bound at the socket path.
   */
  readonly drain: (
    onConnection: (fd: number) => void,
    options?: { readonly graceMs?: number }
  ) => Effect.Effect<number, UpgradeError>;
}

/**
 * The listener inherited across an upgrade, or null on a cold start. Also
 * records the upgrade as done for the `polaris upgrade` that asked for it.
 */
export const adoptListener = Effect.fn("adoptListener")(function* () {
  const handoff = yield* takeHandoff();

  if (handoff === null) return null;
  yield* writeStatus({
    requestId: handoff.requestId,
    state: "done",
    version: VERSION,
    pid: process.pid,
    error: null,
  });

  if (handoff.listenerFd === null) return null;
  const fd = handoff.listenerFd;

  const drain: AdoptedListener["drain"] = (onConnection, options) =>
    Effect.gen(function* () {
      const graceMs = options?.graceMs ?? 250;
      const deadline = Date.now() + graceMs;
      let accepted = 0;

      for (;;) {
        const wait = Math.max(0, deadline - Date.now());

        const ready = yield* Effect.try({
          // Short poll slices keep the event loop responsive during the grace period.
          try: () => libc.pollReadable(fd, Math.min(wait, 10)),
          catch: fail("poll inherited listener"),
        });

        if (ready) {
          const connection = yield* Effect.try({
            try: () => libc.acceptFd(fd),
            catch: fail("accept on inherited listener"),
          });

          onConnection(connection);
          accepted++;
          continue;
        }

        if (wait === 0) break;
        yield* Effect.sleep(5);
      }

      yield* Effect.sync(() => libc.closeFd(fd));

      return accepted;
    });

  return { fd, fromVersion: handoff.fromVersion, drain } satisfies AdoptedListener;
});

/**
 * Wrap a connected socket fd (accepted from the inherited listener, or a
 * Harness socketpair end) as a Bun socket. `Bun.connect({ fd })` works but is
 * missing from Bun's type declarations.
 */
export const connectFd = <Data = undefined>(
  fd: number,
  socket: SocketHandler<Data>
): Promise<Socket<Data>> => Bun.connect({ fd, socket });

const hasFd = Schema.is(Schema.Struct({ fd: Schema.Number }));

/** The fd of a `Bun.listen` listener; present at runtime, missing from the types. */
export const listenerFd = <Data>(listener: SocketListener<Data>): number => {
  if (!hasFd(listener)) throw new Error("listener has no fd");

  return listener.fd;
};

/**
 * Bind a listener at `socketPath` without a window where the path is missing
 * or refuses connections: bind at a temporary sibling path, then rename it
 * over `socketPath` (replacing a stale or inherited socket file).
 */
export const bindAtomically = <A, E, R>(
  socketPath: string,
  bind: (temporaryPath: string) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | UpgradeError, R> =>
  Effect.gen(function* () {
    const temporary = `${socketPath}.${process.pid}.new`;
    yield* Effect.sync(() => rmSync(temporary, { force: true }));
    const listener = yield* bind(temporary);
    yield* Effect.try({
      try: () => renameSync(temporary, socketPath),
      catch: fail("rename socket"),
    });

    return listener;
  });

// ── Upgrade requests (`polaris upgrade <path>` → running Daemon) ───────────

export const upgradeFiles = () => {
  const root = paths().root;

  return {
    /** Written by the Daemon at startup; `polaris upgrade` signals this PID. */
    pid: join(root, "daemon.pid"),
    request: join(root, "upgrade-request.json"),
    status: join(root, "upgrade-status.json"),
  };
};

export const UpgradeRequest = Schema.Struct({
  requestId: Schema.String,
  binary: Schema.String,
  version: Schema.String,
});

export type UpgradeRequest = typeof UpgradeRequest.Type;

export const UpgradeStatus = Schema.Struct({
  requestId: Schema.NullOr(Schema.String),
  state: Schema.Literals(["validating", "exec", "done", "failed"]),
  version: Schema.String,
  pid: Schema.Int,
  error: Schema.NullOr(Schema.String),
});

export type UpgradeStatus = typeof UpgradeStatus.Type;

const writeJsonAtomic = <A>(path: string, value: A) => {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
};

const writeStatus = (status: UpgradeStatus) =>
  Effect.try({
    try: () => writeJsonAtomic(upgradeFiles().status, status),
    catch: fail("write status"),
  });

export const readStatus = Effect.fn("readStatus")(function* () {
  const file = upgradeFiles().status;

  if (!existsSync(file)) return null;

  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(UpgradeStatus))(
    readFileSync(file, "utf8")
  ).pipe(Effect.orElseSucceed(() => null));
});

/** Run `<binary> version` and check it is a Daemon build for this platform. */
export const validateBinary = Effect.fn("validateBinary")(function* (binary: string) {
  const runner = yield* CommandRunner;
  const result = yield* runner.run([binary, "version"], { timeoutMs: 10_000 });
  const info = result.code === 0 ? parseVersionLine(result.stdout) : null;

  if (info === null) {
    return yield* new UpgradeError({
      step: "validate",
      message: `\`${binary} version\` exited ${result.code}: ${(result.stderr || result.stdout).trim()}`,
    });
  }

  const platform = runtimePlatform();

  if (info.platform !== platform) {
    return yield* new UpgradeError({
      step: "validate",
      message: `${binary} is built for ${info.platform}, this Host is ${platform}`,
    });
  }

  return info;
});

export interface UpgradeHooks {
  /** The Daemon's listening socket fd right now, if it has one. */
  readonly listenerFd: () => number | null;
  /** Named fds and children to keep across the exec (Harness socketpairs). */
  readonly collect?: () => Effect.Effect<Required<Omit<HandoffExtras, "requestId">>>;
  /** Last chance to flush state before the process image is replaced. */
  readonly beforeExec?: Effect.Effect<void>;
  /** argv after the binary; defaults to this process's own arguments. */
  readonly args?: ReadonlyArray<string>;
}

/**
 * A Daemon module with fds and children to carry across the exec (terminals'
 * PTY masters and shells). Contributors are asked after `hooks.collect`, in
 * registration order; names must be unique across contributors.
 */
export interface HandoffContributor {
  /** For logs and tests. */
  readonly name?: string;
  readonly collect: () => Effect.Effect<Required<Omit<HandoffExtras, "requestId">>>;
  /** Last chance to write state for the new image (after collect, just before exec). */
  readonly beforeExec?: Effect.Effect<void>;
  /** The exec failed: the old image keeps running, undo `beforeExec`. */
  readonly abort?: Effect.Effect<void>;
}

const contributors = new Set<HandoffContributor>();

/** Register `contributor` for as long as the scope is open. */
export const registerHandoffContributor = (contributor: HandoffContributor) =>
  Effect.acquireRelease(
    Effect.sync(() => contributors.add(contributor)),
    () => Effect.sync(() => contributors.delete(contributor))
  );

/** The contributors registered right now, in registration order. */
export const handoffContributors = (): ReadonlyArray<HandoffContributor> => [...contributors];

const collectContributors = Effect.gen(function* () {
  const fds: Record<string, number> = {};
  const children: Record<string, number> = {};

  for (const contributor of contributors) {
    const extras = yield* contributor.collect();
    Object.assign(fds, extras.fds);
    Object.assign(children, extras.children);
  }

  return { fds, children };
});

/** Validate `request` and exec into it. Returns only if the upgrade failed. */
export const performUpgrade = Effect.fn("performUpgrade")(function* (
  request: UpgradeRequest,
  hooks: UpgradeHooks
) {
  const status = (state: UpgradeStatus["state"], error: string | null = null) =>
    writeStatus({ requestId: request.requestId, state, version: VERSION, pid: process.pid, error });

  yield* status("validating");

  const attempt = Effect.gen(function* () {
    const info = yield* validateBinary(request.binary);

    if (info.version !== request.version) {
      return yield* new UpgradeError({
        step: "validate",
        message: `${request.binary} reports ${info.version}, expected ${request.version}`,
      });
    }

    const own = hooks.collect ? yield* hooks.collect() : { fds: {}, children: {} };
    const contributed = yield* collectContributors;

    const extras = {
      fds: { ...own.fds, ...contributed.fds },
      children: { ...own.children, ...contributed.children },
    };

    const listenerFd = hooks.listenerFd();

    if (hooks.beforeExec) yield* hooks.beforeExec;

    for (const contributor of contributors)
      if (contributor.beforeExec) yield* contributor.beforeExec;

    const abortContributors = Effect.forEach(
      [...contributors],
      (contributor) => contributor.abort ?? Effect.void,
      { discard: true }
    );

    yield* status("exec");

    const env = yield* prepareHandoff(listenerFd, {
      ...extras,
      requestId: request.requestId,
    }).pipe(Effect.tapError(() => abortContributors));

    const kept = [...(listenerFd === null ? [] : [listenerFd]), ...Object.values(extras.fds)];

    return yield* execInto({
      binary: request.binary,
      args: hooks.args ?? process.argv.slice(2),
      env,
    }).pipe(Effect.tapError(() => Effect.andThen(abortHandoff(kept), abortContributors)));
  });

  return yield* attempt.pipe(
    Effect.tapError((error) => status("failed", `${error.step}: ${error.message}`))
  );
});

/**
 * Exec into a new binary whenever `polaris upgrade` leaves a request and
 * sends SIGUSR2. The pid file is written after the handler is installed.
 * Scoped: the handler is removed when the scope closes.
 */
export const serveUpgrades = Effect.fn("serveUpgrades")(function* (hooks: UpgradeHooks) {
  const context = yield* Effect.context<CommandRunner>();
  const files = upgradeFiles();

  const onSignal = () => {
    const program = Effect.gen(function* () {
      const raw = yield* Effect.try({
        try: () => readFileSync(files.request, "utf8"),
        catch: fail("read request"),
      });

      yield* Effect.sync(() => rmSync(files.request, { force: true }));

      const request = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(UpgradeRequest))(
        raw
      ).pipe(Effect.mapError(fail("decode request")));

      yield* performUpgrade(request, hooks);
    }).pipe(
      Effect.catch((error) => Effect.logError("upgrade failed", error)),
      Effect.provideContext(context)
    );

    Effect.runFork(program);
  };

  yield* Effect.acquireRelease(
    Effect.sync(() => process.on("SIGUSR2", onSignal)),
    () =>
      Effect.sync(() => {
        process.off("SIGUSR2", onSignal);

        try {
          if (readFileSync(files.pid, "utf8").trim() === String(process.pid)) rmSync(files.pid);
        } catch {}
      })
  );

  // Only now: SIGUSR2's default action kills the process, and the pid file invites it.
  yield* Effect.try({
    try: () => writeFileSync(files.pid, `${process.pid}\n`),
    catch: fail("write pid file"),
  });
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

/** The PID of the running Daemon, if its pid file names a live process. */
export const runningDaemonPid = (): number | null => {
  try {
    const pid = Number(readFileSync(upgradeFiles().pid, "utf8").trim());

    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);

    return pid;
  } catch {
    return null;
  }
};

/** How a request ended, from the status file; null while it is still going. */
const upgradeOutcome = (
  status: UpgradeStatus | null,
  requestId: string,
  pid: number
): Effect.Effect<UpgradeStatus, UpgradeError> | null => {
  if (status?.requestId !== requestId) {
    if (isAlive(pid)) return null;

    return Effect.fail(
      new UpgradeError({
        step: "wait",
        message: `the Daemon (PID ${pid}) exited instead of upgrading`,
      })
    );
  }

  if (status.state === "failed") {
    return Effect.fail(new UpgradeError({ step: "daemon", message: status.error ?? "failed" }));
  }

  if (status.state !== "done") return null;

  if (status.pid !== pid) {
    return Effect.fail(
      new UpgradeError({
        step: "verify",
        message: `Daemon came back as PID ${status.pid}, not ${pid}`,
      })
    );
  }

  return Effect.succeed(status);
};

/**
 * Ask the running Daemon to exec into `binary` and wait for the new image to
 * report back. The caller has already installed `binary` under
 * `~/.polaris/bin/<version>/` and repointed `current`.
 */
export const requestUpgrade = Effect.fn("requestUpgrade")(function* (options: {
  readonly pid: number;
  readonly binary: string;
  readonly version: string;
  readonly timeoutMs?: number;
}) {
  const files = upgradeFiles();

  const request: UpgradeRequest = {
    requestId: randomUUID(),
    binary: options.binary,
    version: options.version,
  };

  yield* Effect.try({
    try: () => {
      writeJsonAtomic(files.request, request);
      process.kill(options.pid, "SIGUSR2");
    },
    catch: fail("signal Daemon"),
  });
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);

  while (Date.now() < deadline) {
    const outcome = upgradeOutcome(yield* readStatus(), request.requestId, options.pid);

    if (outcome !== null) return yield* outcome;
    yield* Effect.sleep(50);
  }

  return yield* new UpgradeError({
    step: "wait",
    message: "the Daemon did not report back from the upgrade in time",
  });
});
