/**
 * Non-recursive directory watches on Linux, read straight from inotify through `bun:ffi`.
 * Bun's `fs.watch` there drops every event for names starting with `.` or `~` (ADR 0047).
 * One inotify instance serves every watch; Bun's reader waits on it in the event loop's
 * epoll, so an idle watch wakes nothing. It closes with the last watch.
 */
import { dlopen, FFIType, read } from "bun:ffi";
import { constants } from "node:os";
import { libcPath } from "../platform/index.ts";

/** `rename` for entries appearing, going or moving; `change` for writes and metadata. */
export type DirectoryEvent = "rename" | "change";

export interface DirectoryListener {
  /** `name` is null for the directory itself, or after the kernel's queue overflowed. */
  readonly changed: (event: DirectoryEvent, name: string | null) => void;
}

/** `<sys/inotify.h>`; the flags to `inotify_init1` are Linux's generic `O_NONBLOCK` and `O_CLOEXEC`. */
const IN = {
  MODIFY: 0x2,
  ATTRIB: 0x4,
  MOVED_FROM: 0x40,
  MOVED_TO: 0x80,
  CREATE: 0x100,
  DELETE: 0x200,
  DELETE_SELF: 0x400,
  MOVE_SELF: 0x800,
  Q_OVERFLOW: 0x4000,
  IGNORED: 0x8000,
  ONLYDIR: 0x1000000,
  EXCL_UNLINK: 0x4000000,
  NONBLOCK: 0o4000,
  CLOEXEC: 0o2000000,
} as const;

const RENAMES = IN.MOVED_FROM | IN.MOVED_TO | IN.CREATE | IN.DELETE | IN.DELETE_SELF | IN.MOVE_SELF;

const MASK = RENAMES | IN.MODIFY | IN.ATTRIB | IN.ONLYDIR | IN.EXCL_UNLINK;

/** `struct inotify_event` before its name: wd, mask, cookie, len. */
const HEADER = 16;

const load = () =>
  dlopen(libcPath(), {
    inotify_init1: { args: [FFIType.i32], returns: FFIType.i32 },
    inotify_add_watch: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    inotify_rm_watch: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  }).symbols;

let library: ReturnType<typeof load> | null | undefined;

const libc = () => {
  if (library === undefined) {
    try {
      library = load();
    } catch {
      library = null;
    }
  }

  return library;
};

/** Whether this Host can watch directories through inotify; elsewhere use `fs.watch`. */
export const inotifyAvailable = (): boolean => process.platform === "linux" && libc() !== null;

const errnoNames = new Map(Object.entries(constants.errno).map(([name, code]) => [code, name]));

/** An `Error` with the errno's name as `code`, as `node:fs` throws it. */
const failure = (call: string, path: string) => {
  const location = libc()?.__errno_location();
  const errno = location ? read.i32(location, 0) : 0;
  const code = errnoNames.get(errno) ?? "EIO";

  return Object.assign(new Error(`${code}: ${call} '${path}'`), { code, errno, path });
};

/** Bun dups `fd` and waits for it in epoll; cancelling closes the dup. */
const openReader = (fd: number) => Bun.file(fd).stream().getReader();

interface Instance {
  readonly fd: number;
  /** Set once `fd` is closed: its number may already belong to another file. */
  closed: boolean;
  readonly reader: ReturnType<typeof openReader>;
  readonly watches: Map<number, Set<DirectoryListener>>;
}

let current: Instance | undefined;

const eventOf = (mask: number): DirectoryEvent => ((mask & RENAMES) === 0 ? "change" : "rename");

const dispatch = (instance: Instance, wd: number, mask: number, name: string | null) => {
  if ((mask & IN.Q_OVERFLOW) !== 0) {
    for (const listeners of instance.watches.values())
      for (const listener of listeners) listener.changed("rename", null);

    return;
  }

  const listeners = instance.watches.get(wd);

  if (!listeners) return;

  // The kernel dropped this watch (its directory is gone); DELETE_SELF already went out.
  if ((mask & IN.IGNORED) !== 0) instance.watches.delete(wd);
  else for (const listener of listeners) listener.changed(eventOf(mask), name);
};

/** Parses whole events from `bytes`; returns the bytes of an event cut off at the end. */
const parse = (instance: Instance, bytes: Uint8Array): Uint8Array => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  while (offset + HEADER <= bytes.length) {
    const length = view.getUint32(offset + 12, true);

    if (offset + HEADER + length > bytes.length) break;
    const raw = bytes.subarray(offset + HEADER, offset + HEADER + length);
    const end = raw.indexOf(0);
    const name = Buffer.from(end === -1 ? raw : raw.subarray(0, end)).toString();

    dispatch(instance, view.getInt32(offset, true), view.getUint32(offset + 4, true), name || null);
    offset += HEADER + length;
  }

  return bytes.slice(offset);
};

const pump = async (instance: Instance) => {
  let rest: Uint8Array = new Uint8Array(0);

  for (;;) {
    const { done, value } = await instance.reader.read();

    if (done || current !== instance) return;
    rest = parse(instance, rest.length === 0 ? value : Buffer.concat([rest, value]));
  }
};

const shutdown = (instance: Instance) => {
  if (current === instance) current = undefined;

  if (instance.closed) return;
  instance.closed = true;
  void instance.reader.cancel().catch(() => undefined);
  libc()?.close(instance.fd);
};

const start = (symbols: NonNullable<ReturnType<typeof libc>>): Instance => {
  const fd = symbols.inotify_init1(IN.NONBLOCK | IN.CLOEXEC);

  if (fd < 0) throw failure("inotify_init1", "");

  const instance: Instance = {
    fd,
    closed: false,
    reader: openReader(fd),
    watches: new Map(),
  };

  void pump(instance).catch(() => {
    // A failed read ends this instance; its watches see a final event and the next starts afresh.
    shutdown(instance);

    for (const listeners of instance.watches.values())
      for (const listener of listeners) listener.changed("rename", null);
  });

  return instance;
};

/**
 * Watches `directory`'s entries until the returned function is called. Throws like
 * `fs.watch` when the directory can't be watched (`ENOENT`, `ENOTDIR`, `ENOSPC`).
 */
export const watchDirectory = (directory: string, listener: DirectoryListener): (() => void) => {
  const symbols = libc();

  if (!symbols) throw new Error("inotify is unavailable on this Host");
  const instance = current ?? start(symbols);
  current = instance;
  const path = Buffer.from(`${directory}\0`);
  const wd = symbols.inotify_add_watch(instance.fd, path, MASK);

  if (wd < 0) {
    const error = failure("watch", directory);

    if (instance.watches.size === 0) shutdown(instance);
    throw error;
  }

  // The same directory under another spelling shares the kernel's watch and its wd.
  const listeners = instance.watches.get(wd) ?? new Set();
  listeners.add(listener);
  instance.watches.set(wd, listeners);

  return () => {
    if (!listeners.delete(listener) || listeners.size > 0) return;

    if (instance.watches.get(wd) === listeners) {
      instance.watches.delete(wd);

      if (!instance.closed) symbols.inotify_rm_watch(instance.fd, wd);
    }

    if (instance.watches.size === 0) shutdown(instance);
  };
};

/** Diagnostic: whether an inotify instance is open (it closes with the last watch). */
export const inotifyOpen = (): boolean => current !== undefined;
