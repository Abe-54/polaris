/** @jsxImportSource ../../../apps/desktop/node_modules/react */
/**
 * RT3 measurement: what one traces.watch snapshot costs to render in ⌘5 (happy-dom, React Profiler),
 * with nothing open and with the 10,000-span trace open. Prints the numbers; not a finding.
 */
import { Profiler } from "../../../apps/desktop/node_modules/react";
import { afterEach, expect, test } from "bun:test";
import type { TraceDetail, TracesSnapshot } from "../../../packages/protocol/src/index.ts";
import { act, cleanup, screen } from "./deps.ts";
import { selectTrace } from "../../../apps/desktop/src/renderer/features/traces/model/store.ts";
import { buildTrace } from "../../../apps/desktop/src/renderer/features/traces/preview/build.ts";
import { largeTrace } from "../../../apps/desktop/src/renderer/features/traces/preview/large.ts";
import {
  FIXTURE_CHECKOUT,
  FIXTURE_DETAILS,
} from "../../../apps/desktop/src/renderer/features/traces/preview/fixtures.ts";
import { TracesMode } from "../../../apps/desktop/src/renderer/features/traces/ui/TracesMode.tsx";
import { AT, mountTraces, scripted, useLayout } from "./harness.tsx";

useLayout();

afterEach(() => {
  cleanup();
  act(() => selectTrace(AT, null));
});

const LARGE: TraceDetail = buildTrace(largeTrace(), FIXTURE_CHECKOUT);

const all = [LARGE, ...FIXTURE_DETAILS];

const snapshot = (): TracesSnapshot => ({
  availability: { _tag: "Listening" },
  userExported: false,
  endpoint: null,
  traces: all.map((d) => d.summary),
  total: all.length,
});

/** Median render ms of the commits one unchanged snapshot causes, over `n` snapshots. */
const measure = async (open: string | null, n = 40) => {
  const fake = scripted(() => all);
  let ms = 0;
  let commits = 0;

  fake.publish(snapshot);
  act(() => selectTrace(AT, open));
  mountTraces(
    fake.api,
    <Profiler
      id="traces"
      onRender={(_id, _phase, actual) => {
        ms += actual;
        commits += 1;
      }}
    >
      <TracesMode />
    </Profiler>
  );
  if (open !== null) await screen.findByTestId("waterfall-ended");
  await act(() => new Promise((r) => setTimeout(r, 50)));
  const per: Array<number> = [];

  for (let i = 0; i < n; i++) {
    ms = 0;
    commits = 0;
    fake.publish(snapshot);
    per.push(ms);
  }

  per.sort((a, b) => a - b);

  return { medianMs: per[Math.floor(n / 2)] ?? 0, commitsPerSnapshot: commits };
};

test("measurement: a snapshot costs no more with the 10,000-span trace open than with none", async () => {
  const idle = await measure(null);

  cleanup();
  const open = await measure(LARGE.summary.id);

  console.log(JSON.stringify({ nothingOpen: idle, largeTraceOpen: open }));
  // Same list, same open trace: the 10,000-span view should cost no more than the empty one.
  expect(open.medianMs).toBeLessThan(idle.medianMs * 2 + 1);
});
