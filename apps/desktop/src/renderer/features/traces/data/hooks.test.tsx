import "../../../test/dom.testing.ts";
import type { TraceFilter } from "@polaris/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { fixtureTracesApi } from "../preview/fixtureApi.ts";
import { BIG_TRACE, FIXTURE_SESSION } from "../preview/fixtures.ts";
import type { TracesApi } from "./api.ts";
import { providers } from "../ui/mode.testing.tsx";
import { useSpan, useTraces } from "./hooks.tsx";

afterEach(cleanup);

const at = { hostKey: "local", sessionId: FIXTURE_SESSION };

/** The fixture api, recording which watches are open. */
const recording = () => {
  const open = new Set<string>();
  const reads: Array<string> = [];
  const base = fixtureTracesApi();

  const api: TracesApi = {
    watch: (key, filter, on) => {
      const name = JSON.stringify(filter ?? {});

      open.add(name);
      const stop = base.watch(key, filter, on);

      return () => {
        open.delete(name);
        stop();
      };
    },
    get: base.get,
    span: (key, traceId, spanId) => {
      reads.push(spanId);

      return base.span(key, traceId, spanId);
    },
    compare: base.compare,
  };

  const { wrapper } = providers(api);

  return { api, open, reads, wrapper };
};

test("a new filter watches again, stops the old watch and shows the new snapshot", () => {
  const { open, wrapper } = recording();

  const { result, rerender } = renderHook(
    ({ filter }: { filter: TraceFilter }) => useTraces(at, filter),
    {
      wrapper,
      initialProps: { filter: { status: "error" } },
    }
  );

  rerender({ filter: { turn: null } });

  expect([...open]).toEqual([JSON.stringify({ turn: null })]);
  expect(
    result.current.status === "ready" ? result.current.value.traces.map((t) => t.root) : []
  ).toEqual(["GET /invoices"]);
});

interface SpanProps {
  readonly spanId: string | null;
}

const NO_SPAN: SpanProps = { spanId: null };

test("useSpan reads nothing until a span is chosen, then its detail", async () => {
  const { reads, wrapper } = recording();

  const { result, rerender } = renderHook(
    ({ spanId }: SpanProps) => useSpan(at, BIG_TRACE.id, spanId),

    { wrapper, initialProps: NO_SPAN }
  );

  expect([reads.length, result.current.status]).toEqual([0, "loading"]);
  await act(async () => rerender({ spanId: "a91f5d6e7b8c03c2" }));

  expect(result.current.status === "ready" ? result.current.value.span.name : null).toBe(
    "UPDATE invoices"
  );
  expect(result.current.status === "ready" ? result.current.value.logCount : null).toBe(1);
});
