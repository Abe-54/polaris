/**
 * Per-process memory and CPU counters, read without spawning anything:
 *
 * - **macOS**: `proc_pid_rusage(RUSAGE_INFO_V2)` from libSystem via bun:ffi gives
 *   resident size, `phys_footprint` (what Activity Monitor calls Memory: the pages
 *   the process is charged for, including compressed and swapped), user + system
 *   CPU time (in mach time units, converted with `mach_timebase_info`), idle and
 *   interrupt wakeups, and the CPU time of reaped children. `proc_listchildpids`
 *   walks the tree, `proc_name` names each process.
 * - **Linux**: `/proc/<pid>/stat` (utime, stime, cutime, cstime in clock ticks,
 *   assumed 100 Hz, which is `USER_HZ` on every mainstream kernel), `/proc/<pid>/status`
 *   (VmRSS; footprint = RssAnon + RssShmem, the pages not backed by a file) and the
 *   voluntary + involuntary context switches of every thread as the wakeup count.
 *   Children come from `/proc/<pid>/task/<tid>/children`.
 * - Anything else, or when the above fails: `ps -o pid=,ppid=,rss=,time=,comm=`
 *   (RSS and CPU only, and it spawns a process per read; CPU time has 10 ms
 *   resolution on macOS but whole seconds with Linux procps).
 *
 * Only processes of the same user can be read, which is all a benchmark needs.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dlopen, FFIType, ptr } from "bun:ffi";

export interface ProcCounters {
  readonly pid: number;
  readonly name: string;
  readonly rssBytes: number;
  /** macOS phys_footprint; Linux RssAnon + RssShmem; null when unknown. */
  readonly footprintBytes: number | null;
  /** User + system CPU time of this process, ns. */
  readonly cpuNs: number;
  /** User + system CPU time of its children that exited and were reaped, ns. */
  readonly childCpuNs: number;
  /** macOS: idle + interrupt wakeups; Linux: context switches of all threads; null when unknown. */
  readonly wakeups: number | null;
}

export interface ProcReader {
  readonly backend: "darwin-libproc" | "linux-procfs" | "ps";
  readonly read: (pid: number) => ProcCounters | null;
  readonly children: (pid: number) => ReadonlyArray<number>;
}

// ── macOS ───────────────────────────────────────────────────────────────────

const RUSAGE_INFO_V2 = 2;

const RUSAGE_V2_SIZE = 160;

const darwinReader = (): ProcReader | null => {
  try {
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      proc_listchildpids: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      proc_name: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 },
    });

    const timebase = new Uint32Array(2);
    lib.symbols.mach_timebase_info(ptr(timebase));
    const toNs = (timebase[0] ?? 1) / (timebase[1] ?? 1);
    const usage = new BigUint64Array(RUSAGE_V2_SIZE / 8);
    const nameBuf = new Uint8Array(256);
    const pidBuf = new Int32Array(4096);
    // ptr() is taken per call: JSC may move a small typed array's storage.
    const n = (i: number) => Number(usage[i] ?? 0n);

    return {
      backend: "darwin-libproc",
      read: (pid) => {
        if (lib.symbols.proc_pid_rusage(pid, RUSAGE_INFO_V2, ptr(usage)) !== 0) return null;
        nameBuf.fill(0);
        const len = Math.max(0, lib.symbols.proc_name(pid, ptr(nameBuf), nameBuf.byteLength));
        const nul = nameBuf.indexOf(0);

        // Offsets (u64 words) in struct rusage_info_v2, after the 16-byte uuid.
        return {
          pid,
          name: new TextDecoder().decode(nameBuf.subarray(0, nul >= 0 ? Math.min(nul, len) : len)),
          cpuNs: (n(2) + n(3)) * toNs,
          wakeups: n(4) + n(5),
          rssBytes: n(8),
          footprintBytes: n(9),
          childCpuNs: (n(12) + n(13)) * toNs,
        };
      },
      children: (pid) => {
        const count = lib.symbols.proc_listchildpids(pid, ptr(pidBuf), pidBuf.byteLength);

        return count > 0 ? [...pidBuf.subarray(0, count)] : [];
      },
    };
  } catch {
    return null;
  }
};

// ── Linux ───────────────────────────────────────────────────────────────────

const TICK_NS = 1e9 / 100;

const linuxReader = (): ProcReader | null => {
  try {
    readFileSync("/proc/self/stat", "utf8");
  } catch {
    return null;
  }

  const statusKb = (status: string, key: string): number | null => {
    const match = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(status);

    return match ? Number(match[1]) * 1024 : null;
  };

  return {
    backend: "linux-procfs",
    read: (pid) => {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        const name = stat.slice(stat.indexOf("(") + 1, close);

        // Fields after "(comm)": state is field 3, utime 14, stime 15, cutime 16, cstime 17.
        const f = stat
          .slice(close + 2)
          .split(" ")
          .map((x) => Number(x));

        const at = (field: number) => f[field - 3] ?? 0;
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        const anon = statusKb(status, "RssAnon");
        const shmem = statusKb(status, "RssShmem");
        let wakeups = 0;

        for (const tid of readdirSync(`/proc/${pid}/task`)) {
          try {
            const t = readFileSync(`/proc/${pid}/task/${tid}/status`, "utf8");
            wakeups +=
              Number(/^voluntary_ctxt_switches:\s+(\d+)/m.exec(t)?.[1] ?? 0) +
              Number(/^nonvoluntary_ctxt_switches:\s+(\d+)/m.exec(t)?.[1] ?? 0);
          } catch {}
        }

        return {
          pid,
          name,
          rssBytes: statusKb(status, "VmRSS") ?? 0,
          footprintBytes: anon === null ? null : anon + (shmem ?? 0),
          cpuNs: (at(14) + at(15)) * TICK_NS,
          childCpuNs: (at(16) + at(17)) * TICK_NS,
          wakeups,
        };
      } catch {
        return null;
      }
    },
    children: (pid) => {
      const out: Array<number> = [];

      try {
        for (const tid of readdirSync(`/proc/${pid}/task`)) {
          try {
            const text = readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8").trim();

            if (text) for (const c of text.split(/\s+/)) out.push(Number(c));
          } catch {}
        }
      } catch {}

      return out;
    },
  };
};

// ── ps fallback ─────────────────────────────────────────────────────────────

const psTime = (text: string): number => {
  // [[dd-]hh:]mm:ss[.cc]
  const [days, rest] = text.includes("-") ? text.split("-") : ["0", text];
  const parts = (rest ?? "0").split(":").map(Number);
  let seconds = 0;

  for (const p of parts) seconds = seconds * 60 + p;

  return (Number(days) * 86400 + seconds) * 1e9;
};

const psReader = (): ProcReader => {
  const table = () => {
    const out = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,rss=,time=,comm="]).stdout.toString();

    return out
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((cols) => cols.length >= 5)
      .map(([pid, ppid, rss, time, ...comm]) => ({
        pid: Number(pid),
        ppid: Number(ppid),
        rss: Number(rss) * 1024,
        cpuNs: psTime(time ?? "0"),
        name: comm.join(" "),
      }));
  };

  return {
    backend: "ps",
    read: (pid) => {
      const row = table().find((r) => r.pid === pid);

      return row
        ? {
            pid,
            name: row.name,
            rssBytes: row.rss,
            footprintBytes: null,
            cpuNs: row.cpuNs,
            childCpuNs: 0,
            wakeups: null,
          }
        : null;
    },
    children: (pid) =>
      table()
        .filter((r) => r.ppid === pid)
        .map((r) => r.pid),
  };
};

let cached: ProcReader | undefined;

/** The best reader for this platform; `POLARIS_BENCH_PS=1` forces the ps fallback. */
export const procReader = (): ProcReader => {
  if (cached !== undefined) return cached;

  if (process.env.POLARIS_BENCH_PS === "1") cached = psReader();
  else if (process.platform === "darwin") cached = darwinReader() ?? psReader();
  else if (process.platform === "linux") cached = linuxReader() ?? psReader();
  else cached = psReader();

  return cached;
};

/** `root` and every live descendant. */
export const processTree = (root: number, reader = procReader()): Array<number> => {
  const out: Array<number> = [];
  const queue = [root];

  while (queue.length > 0) {
    const pid = queue.shift()!;

    if (out.includes(pid)) continue;
    out.push(pid);
    queue.push(...reader.children(pid));
  }

  return out;
};
