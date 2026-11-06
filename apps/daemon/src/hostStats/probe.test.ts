import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { cpuPercent } from "./HostStats.ts";
import { parseMeminfo, parseProcStat, systemProbe } from "./probe.ts";

// A Raspberry Pi 4's, trimmed: user nice system idle iowait irq softirq steal guest guest_nice.
const PROC_STAT = `cpu  4705 150 1120 16250 520 0 37 0 300 0
cpu0 1393 32 291 4034 129 0 21 0 0 0
intr 1462898
`;

const MEMINFO = `MemTotal:        3884328 kB
MemFree:          201144 kB
MemAvailable:    2861460 kB
Buffers:          120504 kB
Cached:          2410112 kB
`;

describe("probe parsers", () => {
  test("/proc/stat: idle and iowait are idle, and guest time isn't counted twice", () => {
    expect(parseProcStat(PROC_STAT)).toEqual({ busy: 6012, total: 22782 });
  });

  test("/proc/meminfo: the page cache isn't used memory", () => {
    expect(parseMeminfo(MEMINFO)).toEqual({
      usedBytes: (3884328 - 2861460) * 1024,
      totalBytes: 3884328 * 1024,
    });
  });

  test("a kernel without MemAvailable falls back", () => {
    expect(parseMeminfo("MemTotal: 1024 kB\nMemFree: 512 kB\n")).toBeNull();
  });

  test("CPU share is the busy fraction of the interval, and a stalled counter reads idle", () => {
    expect(cpuPercent({ busy: 0, total: 0 }, { busy: 50, total: 200 })).toBe(25);
    expect(cpuPercent({ busy: 10, total: 100 }, { busy: 10, total: 100 })).toBe(0);
  });
});

describe("systemProbe on this Host", () => {
  test("reads plausible memory, disk and CPU, and CPU time moves", async () => {
    const probe = systemProbe(tmpdir());
    const first = probe.read();
    await Bun.sleep(50);
    const second = probe.read();

    expect(probe.cores()).toBeGreaterThan(0);
    expect(second.memory.usedBytes).toBeGreaterThan(0);
    expect(second.memory.usedBytes).toBeLessThanOrEqual(second.memory.totalBytes);
    expect(second.disk?.usedBytes).toBeLessThanOrEqual(second.disk?.totalBytes ?? -1);
    expect(second.cpu.total).toBeGreaterThan(first.cpu.total);
    expect(second.loadAverage === null).toBe(process.platform === "win32");
  });
});
