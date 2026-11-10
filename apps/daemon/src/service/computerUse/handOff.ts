/**
 * The Daemon's side of the hand-off to the helper's launcher (ADR 0107, ENG-867): three
 * socket pairs, and one Mach message that carries the launcher's ends as fileports. The
 * kernel stamps that message with this process's audit token, which is what the launcher
 * checks; nothing a caller could say about itself is trusted. macOS only.
 */
import { dlopen, FFIType } from "bun:ffi";

/** Values from the macOS headers; `HAND_OFF_ID` is the one in `launcher.c`. */
const C = {
  AF_UNIX: 1,
  SOCK_STREAM: 1,
  /** `_IO('f', 1)`: close on exec, so no other child of the Daemon inherits a tool's stdio. */
  FIOCLEX: 0x2000_6601,
  TASK_BOOTSTRAP_PORT: 4,
  MACH_SEND_MSG: 0x1,
  MACH_SEND_TIMEOUT: 0x10,
  MACH_MSG_TYPE_COPY_SEND: 19,
  MACH_MSGH_BITS_COMPLEX: 0x8000_0000,
  MACH_MSG_PORT_DESCRIPTOR: 0,
  HAND_OFF_ID: 0x5043_4855,
  SEND_TIMEOUT_MS: 250,
} as const;

const load = () =>
  dlopen("/usr/lib/libSystem.B.dylib", {
    socketpair: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr],
      returns: FFIType.i32,
    },
    // Variadic in C; FIOCLEX reads no third argument, so two fixed ones are the whole call.
    ioctl: { args: [FFIType.i32, FFIType.u64], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    fileport_makeport: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    task_self_trap: { args: [], returns: FFIType.u32 },
    task_get_special_port: {
      args: [FFIType.u32, FFIType.i32, FFIType.ptr],
      returns: FFIType.i32,
    },
    bootstrap_look_up: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    mach_port_deallocate: { args: [FFIType.u32, FFIType.u32], returns: FFIType.i32 },
    mach_msg: {
      args: [
        FFIType.ptr,
        FFIType.i32,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
      ],
      returns: FFIType.i32,
    },
  }).symbols;

let loaded: ReturnType<typeof load> | undefined;

const lib = () => (loaded ??= load());

/** One end of each socket for the Daemon, the other for the launcher. */
export interface Channels {
  /** Control, data (the tool's stdin and stdout) and stderr, in that order. */
  readonly mine: ReadonlyArray<number>;
  readonly theirs: ReadonlyArray<number>;
}

export const closeAll = (fds: ReadonlyArray<number>) => {
  for (const fd of fds) lib().close(fd);
};

/** Three connected socket pairs, none of them inherited by a child. */
export const openChannels = (): Channels => {
  const mine: Array<number> = [];
  const theirs: Array<number> = [];

  for (let i = 0; i < 3; i++) {
    const pair = new Int32Array(2);

    if (lib().socketpair(C.AF_UNIX, C.SOCK_STREAM, 0, pair) !== 0) {
      closeAll([...mine, ...theirs]);
      throw new Error("socketpair failed");
    }

    mine.push(pair[0]!);
    theirs.push(pair[1]!);
    lib().ioctl(pair[0]!, C.FIOCLEX);
    lib().ioctl(pair[1]!, C.FIOCLEX);
  }

  return { mine, theirs };
};

const task = () => lib().task_self_trap();

/** A send right to the Mach service `name` in this process's bootstrap; null until it is checked in. */
export const lookUp = (name: string): number | null => {
  const out = new Uint32Array(1);

  if (lib().task_get_special_port(task(), C.TASK_BOOTSTRAP_PORT, out) !== 0) return null;
  const bootstrap = out[0]!;
  const found = lib().bootstrap_look_up(bootstrap, Buffer.from(`${name}\0`), out);
  lib().mach_port_deallocate(task(), bootstrap);

  return found === 0 ? out[0]! : null;
};

/**
 * Sends `fds` to `port` as fileports in one message and gives up `port`. The layout is
 * `struct hand_off` in `launcher.c`: header (24 bytes), descriptor count, three descriptors.
 */
export const sendFiles = (port: number, fds: ReadonlyArray<number>): void => {
  const size = 28 + fds.length * 12;
  const message = new DataView(new ArrayBuffer(size));
  const rights: Array<number> = [];

  try {
    message.setUint32(0, (C.MACH_MSGH_BITS_COMPLEX | C.MACH_MSG_TYPE_COPY_SEND) >>> 0, true);
    message.setUint32(4, size, true);
    message.setUint32(8, port, true);
    message.setUint32(20, C.HAND_OFF_ID, true);
    message.setUint32(24, fds.length, true);

    fds.forEach((fd, index) => {
      const out = new Uint32Array(1);

      if (lib().fileport_makeport(fd, out) !== 0) throw new Error("fileport_makeport failed");
      rights.push(out[0]!);
      message.setUint32(28 + index * 12, out[0]!, true);
      message.setUint8(28 + index * 12 + 10, C.MACH_MSG_TYPE_COPY_SEND);
      message.setUint8(28 + index * 12 + 11, C.MACH_MSG_PORT_DESCRIPTOR);
    });

    const sent = lib().mach_msg(
      new Uint8Array(message.buffer),
      C.MACH_SEND_MSG | C.MACH_SEND_TIMEOUT,
      size,
      0,
      0,
      C.SEND_TIMEOUT_MS,
      0
    );

    if (sent !== 0) throw new Error(`mach_msg failed (0x${(sent >>> 0).toString(16)})`);
  } finally {
    // The message copied every right, so this process's own references all go.
    for (const right of [...rights, port]) lib().mach_port_deallocate(task(), right);
  }
};
