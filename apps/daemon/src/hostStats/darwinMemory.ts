/**
 * Memory in use on macOS, read with `host_statistics64` through `bun:ffi` (about a
 * microsecond). `os.freemem()` there counts only free pages, so the page cache reads as used.
 */
import { dlopen, FFIType } from "bun:ffi";
import { libcPath } from "../platform/index.ts";

/** `<mach/host_info.h>`: `HOST_VM_INFO64`, and `vm_statistics64_data_t` in 32-bit words. */
const HOST_VM_INFO64 = 4;

const HOST_VM_INFO64_COUNT = 38;

/** Byte offsets of the `natural_t` page counts used below, in `vm_statistics64`. */
const OFFSET = { wire: 12, purgeable: 88, compressor: 128, internal: 140 } as const;

const bind = () =>
  dlopen(libcPath(), {
    mach_host_self: { args: [], returns: FFIType.u32 },
    getpagesize: { args: [], returns: FFIType.i32 },
    host_statistics64: {
      args: [FFIType.u32, FFIType.i32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
  }).symbols;

let mach: { readonly symbols: ReturnType<typeof bind>; readonly host: number } | null = null;

const stats = new Uint32Array(HOST_VM_INFO64_COUNT);

const count = new Uint32Array(1);

/** App memory (anonymous pages less purgeable ones), wired and compressed: Activity Monitor's "Memory Used". */
export const darwinMemoryUsed = (): number | null => {
  if (mach === null) {
    const symbols = bind();
    mach = { symbols, host: symbols.mach_host_self() };
  }

  count[0] = HOST_VM_INFO64_COUNT;

  if (mach.symbols.host_statistics64(mach.host, HOST_VM_INFO64, stats, count) !== 0) return null;
  const view = new DataView(stats.buffer);
  const pages = (offset: number) => view.getUint32(offset, true);

  const used =
    pages(OFFSET.internal) -
    pages(OFFSET.purgeable) +
    pages(OFFSET.wire) +
    pages(OFFSET.compressor);

  return used * mach.symbols.getpagesize();
};
