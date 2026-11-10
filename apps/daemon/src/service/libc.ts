/**
 * The handful of libc calls the upgrade hand-off needs and Bun does not
 * expose: `execve` (replace this process image, same PID), close-on-exec
 * control, raw `accept`/`poll` on an inherited listener, `socketpair`, and
 * `waitpid` for children adopted across an exec.
 *
 * Only fixed-arity functions are bound. `fcntl` and `ioctl` are variadic; on
 * Apple arm64 variadic arguments go on the stack, so binding them with a
 * fixed third argument would pass garbage. We therefore only call `fcntl`
 * with `F_GETFD` (no third argument) and clear close-on-exec with
 * `ioctl(fd, FIONCLEX)`, which takes none either.
 */

import { CString, dlopen, FFIType, ptr, read } from "bun:ffi";
import { hostPlatform, libcPath } from "../platform/index.ts";

const isDarwin = hostPlatform().os === "darwin";

/** musl's libc is its dynamic loader; Alpine has no `libc.so.6`. */
const LIBC_PATH = libcPath();

/** `_IO('f', 2)` on Darwin; the asm-generic value on Linux. */
const FIONCLEX = isDarwin ? 0x20006602n : 0x5450n;

/** `_IO('f', 1)` on Darwin; the asm-generic value on Linux. */
const FIOCLEX = isDarwin ? 0x20006601n : 0x5451n;

const F_GETFD = 1;

const FD_CLOEXEC = 1;

const AF_UNIX = 1;

const SOCK_STREAM = 1;

const SOL_SOCKET = isDarwin ? 0xffff : 1;

const SO_ACCEPTCONN = isDarwin ? 0x0002 : 30;

const SO_TYPE = isDarwin ? 0x1008 : 3;

const POLLIN = 0x1;

const WNOHANG = 1;

const EINTR = 4;

type Libc = ReturnType<typeof open>;

const SYMBOLS = {
  execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  ioctl: { args: [FFIType.i32, FFIType.u64], returns: FFIType.i32 },
  fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  getsockopt: {
    args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  accept: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  poll: { args: [FFIType.ptr, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  socketpair: {
    args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr],
    returns: FFIType.i32,
  },
  waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  ptsname: { args: [FFIType.i32], returns: FFIType.ptr },
} as const;

const ERRNO_LOCATION = { args: [], returns: FFIType.ptr } as const;

// Darwin exports errno through `__error()`, glibc through `__errno_location()`.
const open = () =>
  isDarwin
    ? dlopen(LIBC_PATH, {
        ...SYMBOLS,
        __error: ERRNO_LOCATION,
        proc_pidfdinfo: {
          args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
      })
    : dlopen(LIBC_PATH, { ...SYMBOLS, __errno_location: ERRNO_LOCATION });

let lib: Libc | undefined;

const libc = (): Libc["symbols"] => {
  lib ??= open();

  return lib.symbols;
};

const errno = (): number => {
  const symbols = libc();
  const location = "__error" in symbols ? symbols.__error() : symbols.__errno_location();

  return location ? read.i32(location, 0) : 0;
};

export class LibcError extends Error {
  constructor(
    readonly call: string,
    readonly code: number
  ) {
    super(`${call} failed (errno ${code})`);
    this.name = "LibcError";
  }
}

const check = (call: string, result: number): number => {
  if (result < 0) throw new LibcError(call, errno());

  return result;
};

/** A NUL-terminated copy of `value`, kept alive by the caller until the call returns. */
const cString = (value: string): Buffer => Buffer.from(`${value}\0`, "utf8");

/** Whether `fd` has close-on-exec set. Throws if `fd` is not open. */
export const isCloseOnExec = (fd: number): boolean =>
  (check("fcntl(F_GETFD)", libc().fcntl(fd, F_GETFD)) & FD_CLOEXEC) !== 0;

/** Whether an open descriptor is a stream socket, as used for Harness handoffs. */
export const isStreamSocket = (fd: number): boolean => {
  const kind = new Int32Array(1);
  const length = new Uint32Array([kind.byteLength]);
  const result = libc().getsockopt(fd, SOL_SOCKET, SO_TYPE, kind, length);

  return result === 0 && kind[0] === SOCK_STREAM;
};

/** Whether `fd` is an open listening socket, rather than a reused file or connected socket. */
export const isListeningSocket = (fd: number): boolean => {
  const symbols = libc();

  if ("proc_pidfdinfo" in symbols) {
    // Darwin's socket_fdinfo is 792 bytes; psi.soi_options is at 188 (sys/proc_info.h).
    const info = new Uint8Array(792);
    const result = symbols.proc_pidfdinfo(process.pid, fd, 3, info, info.byteLength);

    return (
      result === info.byteLength && (new DataView(info.buffer).getInt16(188, true) & 0x0002) !== 0
    );
  }

  const accepting = new Int32Array(1);
  const length = new Uint32Array([accepting.byteLength]);
  const result = symbols.getsockopt(fd, SOL_SOCKET, SO_ACCEPTCONN, accepting, length);

  return result === 0 && accepting[0] !== 0;
};

/** Clear close-on-exec so `fd` survives `execve`. */
export const clearCloseOnExec = (fd: number): void => {
  check("ioctl(FIONCLEX)", libc().ioctl(fd, FIONCLEX));
};

/** Set close-on-exec so `fd` does not leak into children spawned later. */
export const setCloseOnExec = (fd: number): void => {
  check("ioctl(FIOCLEX)", libc().ioctl(fd, FIOCLEX));
};

export const closeFd = (fd: number): void => {
  check("close", libc().close(fd));
};

/**
 * Whether `fd` has something to read (for a listener: a pending connection)
 * within `timeoutMs`. Blocks the calling thread for at most `timeoutMs`.
 */
export const pollReadable = (fd: number, timeoutMs: number): boolean => {
  // struct pollfd { int fd; short events; short revents; }
  const pollfd = new Uint8Array(8);
  const view = new DataView(pollfd.buffer);
  view.setInt32(0, fd, true);
  view.setInt16(4, POLLIN, true);

  for (;;) {
    const ready = libc().poll(pollfd, 1, timeoutMs);

    if (ready < 0 && errno() === EINTR) continue;
    check("poll", ready);

    return ready > 0 && (view.getInt16(6, true) & POLLIN) !== 0;
  }
};

/** `accept(2)` on a listening socket; call only after `pollReadable` said yes. */
export const acceptFd = (listenerFd: number): number =>
  check("accept", libc().accept(listenerFd, null, null));

/**
 * A connected pair of Unix stream sockets. Handing one end to a child as its
 * stdin and stdout gives the parent a single fd per child that it can pass
 * through `execve` and re-wrap with `Bun.connect({ fd })` afterwards.
 */
export const socketPair = (): readonly [number, number] => {
  const fds = new Int32Array(2);
  check("socketpair", libc().socketpair(AF_UNIX, SOCK_STREAM, 0, fds));

  return [fds[0]!, fds[1]!];
};

/**
 * Reap `pid` if it has exited (non-blocking). Children adopted across an exec
 * are unknown to the new Bun runtime, so it must reap them itself.
 * Returns the raw wait status, or null while the child is still running.
 */
export const reapChild = (pid: number): number | null => {
  const status = new Int32Array(1);
  const result = check("waitpid", libc().waitpid(pid, status, WNOHANG));

  return result === 0 ? null : status[0]!;
};

/** The slave device of a PTY master fd (`/dev/ttys004`, `/dev/pts/3`), or null if `fd` is none. */
export const ptsname = (fd: number): string | null => {
  const name = libc().ptsname(fd);

  return name === null ? null : new CString(name).toString();
};

/** Every open fd below `limit`, found by probing each with `fcntl(F_GETFD)`. */
export const openFds = (limit = 1024): Array<number> => {
  const fds: Array<number> = [];
  const { fcntl } = libc();

  for (let fd = 0; fd < limit; fd++) if (fcntl(fd, F_GETFD) >= 0) fds.push(fd);

  return fds;
};

/** Decode a `waitpid` status: the exit code, or null when a signal ended the process. */
export const exitCodeOf = (status: number): number | null =>
  (status & 0x7f) === 0 ? (status >> 8) & 0xff : null;

/**
 * Replace this process image with `path`, keeping the PID, every fd without
 * close-on-exec, and all child processes. Only returns by throwing.
 */
export const execve = (
  path: string,
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>
): never => {
  const keepAlive: Array<Buffer> = [];

  const pointerArray = (values: ReadonlyArray<string>): BigUint64Array => {
    const array = new BigUint64Array(values.length + 1);
    values.forEach((value, index) => {
      const buffer = cString(value);
      keepAlive.push(buffer);
      array[index] = BigInt(ptr(buffer));
    });

    return array;
  };

  const envEntries = Object.entries(env).flatMap(([key, value]) =>
    value === undefined ? [] : [`${key}=${value}`]
  );

  const argvArray = pointerArray(argv);
  const envArray = pointerArray(envEntries);
  const pathBuffer = cString(path);
  const result = libc().execve(pathBuffer, argvArray, envArray);
  keepAlive.length = 0;
  throw new LibcError("execve", result < 0 ? errno() : -1);
};
