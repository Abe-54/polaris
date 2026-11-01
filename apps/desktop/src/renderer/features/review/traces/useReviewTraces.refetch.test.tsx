/**
 * useReviewTraces over the fixture Traces API: refetch on reconnect and the pane while a pick
 * loads. Each test failed on 99ca0343d (RPU, P8U).
 */
import { afterEach, expect, test } from "bun:test";
import { TurnId } from "@polaris/protocol";
import { act, cleanup, waitFor } from "@testing-library/react";
import type { TracesApi } from "../../traces/index.ts";
import { fixtureTracesApi } from "../../traces/preview/fixtureApi.ts";
import type { ReviewTurn } from "../data/source.ts";
import { useTracesSection } from "./section.ts";
import { closeTracesCompare, openTracesCompare } from "./store.ts";
import { host, mount, mountWith } from "./daemonFit.testing.tsx";

afterEach(() => {
  closeTracesCompare("s");
  cleanup();
});

/** The fixture traces' Turns, as Review lists them. */
const TURNS: ReadonlyArray<ReviewTurn> = [10, 11, 12].map((number) => ({
  id: TurnId.make(`t-overdue-${number}`),
  number,
  prompt: null,
  turns: [
    {
      id: TurnId.make(`t-overdue-${number}`),
      index: number,
      prompt: "",
      checkpointBefore: null,
      checkpointAfter: null,
      status: "completed",
    },
  ],
}));

const pick = (number: number) =>
  ({ kind: "turn", turnId: TurnId.make(`t-overdue-${number}`) }) as const;

test("P8U-5: a comparison that failed while the Host was away is asked again on reconnect", async () => {
  const base = fixtureTracesApi();
  let calls = 0;

  const api: TracesApi = {
    ...base,
    compare: (at, a, b) =>
      ++calls === 1
        ? Promise.resolve({
            ok: false,
            error: { code: "NotConnected", message: "Mac Studio is reconnecting" },
          })
        : base.compare(at, a, b),
  };

  const away = { turns: TURNS, pick: pick(12), host: host("reconnecting", 1) };
  const { result, rerender } = mount(api, away);

  await waitFor(() => expect(result.current?.answer.status).toBe("failed"));
  rerender({ ...away, host: host("connected", 2) });

  await waitFor(() => expect(result.current?.answer.status).toBe("ready"), { timeout: 500 });
});

test("P8U-6: Route timings keeps the diff pane while a new pick's comparison loads", async () => {
  const base = fixtureTracesApi();
  let calls = 0;

  const api: TracesApi = {
    ...base,
    compare: (at, a, b) => (++calls === 1 ? base.compare(at, a, b) : new Promise(() => undefined)),
  };

  const first = { turns: TURNS, pick: pick(12) };
  const { result, rerender } = mountWith(api, first, (traces) => useTracesSection("s", traces));

  await waitFor(() => expect(result.current.list).not.toBeNull());
  act(() => openTracesCompare("s"));
  expect(result.current.shown).toBe(true);

  rerender({ ...first, pick: pick(11) });

  expect(result.current.shown).toBe(true);
});
