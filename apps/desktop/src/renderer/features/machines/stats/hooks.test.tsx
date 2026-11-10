import "../../../test/dom.testing.ts";
import { HostDiskUsage, HostStatsItem, HostStatsSample, Timestamp } from "@polaris/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import type { IpcError } from "../../../../shared/api.ts";
import { installFakeBridge } from "../../../test/bridge.testing.ts";
import { standInBridge } from "../../bridge.ts";
import { useHostStats } from "./hooks.ts";

afterEach(() => {
  cleanup();
  standInBridge(null);
});

const history = (cpu: number) =>
  HostStatsItem.cases.History.make({
    cores: 8,
    intervalMs: 2000,
    samples: [
      HostStatsSample.make({
        at: Timestamp.make(`2026-11-09T12:00:0${cpu % 10}.000Z`),
        cpuPercent: cpu,
        loadAverage: null,
        memoryUsedBytes: 1,
        memoryTotalBytes: 2,
        disk: HostDiskUsage.make({ path: "/", usedBytes: 1, totalBytes: 2 }),
      }),
    ],
  });

const LOST: IpcError = { code: "RpcClientError", message: "stream closed" };

const tick = () =>
  act(async () => {
    await Bun.sleep(5);
  });

/** A watched Host whose waits are recorded and take no time. */
const watched = (watch = true) => {
  const bridge = installFakeBridge();
  const waits: Array<number> = [];

  const retryMs = (failures: number) => {
    waits.push(failures);

    return 0;
  };

  const hook = renderHook(({ on }) => useHostStats("pi", on, { retryMs }), {
    initialProps: { on: watch },
  });

  return { feeds: () => bridge.feeds("host.stats"), waits, hook };
};

test("a feed that ends while the Host is watched opens again and keeps the samples", async () => {
  const { feeds, hook } = watched();

  act(() => feeds()[0]?.listener.items([history(10)]));
  act(() => feeds()[0]?.listener.end?.(LOST));
  await tick();

  expect(feeds()).toHaveLength(2);
  expect(hook.result.current?.samples.map((s) => s.cpuPercent)).toEqual([10]);
  act(() => feeds()[1]?.listener.items([history(20)]));
  expect(hook.result.current?.samples.at(-1)?.cpuPercent).toBe(20);
});

test("ends in a row back off further; samples reset the backoff", async () => {
  const { feeds, waits } = watched();

  act(() => feeds()[0]?.listener.end?.(LOST));
  await tick();
  act(() => feeds()[1]?.listener.end?.(LOST));
  await tick();
  act(() => feeds()[2]?.listener.items([history(30)]));
  act(() => feeds()[2]?.listener.end?.(LOST));
  await tick();

  expect(waits).toEqual([0, 1, 0]);
  expect(feeds()).toHaveLength(4);
});

test("a feed that ends once the Host is no longer watched stays closed", async () => {
  const { feeds, hook } = watched();

  hook.rerender({ on: false });
  act(() => feeds()[0]?.listener.end?.(LOST));
  await tick();

  expect(feeds()).toHaveLength(1);
});
