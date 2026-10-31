/** @jsxImportSource ../../../apps/desktop/node_modules/react */
/**
 * RT3 repros on the real ⌘5 Traces mode. Each test names a finding in ../2026-10-31-traces-RT3.md
 * and fails on b29792874; it should pass once that finding is fixed.
 */
import {
  SessionId,
  type TraceDetail,
  type TraceFilter,
  type TracesSnapshot,
  TurnId,
} from "../../../packages/protocol/src/index.ts";
import { act, cleanup, fireEvent, renderHook, screen, waitFor, within } from "./deps.ts";
import { useTurnTraces } from "../../../apps/desktop/src/renderer/features/traces/output/useTurnTraces.ts";
import { TraceList } from "../../../apps/desktop/src/renderer/features/traces/ui/sidebar/TraceList.tsx";
import { afterEach, expect, test } from "bun:test";
import { selectSpan, selectTrace } from "../../../apps/desktop/src/renderer/features/traces/model/store.ts";
import { fixtureTracesApi } from "../../../apps/desktop/src/renderer/features/traces/preview/fixtureApi.ts";
import {
  BIG_TRACE,
  ERROR_TRACE,
  FIXTURE_DETAILS,
} from "../../../apps/desktop/src/renderer/features/traces/preview/fixtures.ts";
import { AT, host, mountTraces, providers, scripted, useLayout } from "./harness.tsx";

useLayout();

afterEach(() => {
  cleanup();
  act(() => selectTrace(AT, null));
});

const listening = (details: ReadonlyArray<TraceDetail>): TracesSnapshot => ({
  availability: { _tag: "Listening" },
  userExported: false,
  endpoint: null,
  traces: details.map((d) => d.summary),
  total: details.length,
});

const detailOf = (id: string) => {
  const found = FIXTURE_DETAILS.find((d) => d.summary.id === id);

  if (found === undefined) throw new Error(`No fixture ${id}`);

  return found;
};

test("finding 1: after the connection drops and comes back, ⌘5 watches again", async () => {
  const fake = scripted(() => FIXTURE_DETAILS);

  fake.publish(() => listening(FIXTURE_DETAILS));
  const { store } = mountTraces(fake.api);

  await screen.findAllByTestId("traces-row");

  // The main process ends traces.watch when the connection drops (main/ipc/traces.ts).
  fake.dropAll({ code: "Disconnected", message: "The connection to Mac Studio closed" });
  act(() => store.setState({ hosts: [host("reconnecting", 1)] }));
  act(() => store.setState({ hosts: [host("connected", 2)] }));

  expect(fake.watches.filter((w) => !w.closed).length).toBeGreaterThan(0);
  expect(screen.queryByTestId("traces-setup-failed")).toBeNull();
  expect(screen.queryByTestId("traces-sidebar-quiet")?.textContent ?? "").not.toContain(
    "connection"
  );
});

test("finding 1: a watch that ends cleanly on a drop is reopened, so new traces show", async () => {
  const fake = scripted(() => FIXTURE_DETAILS);
  const [first, ...rest] = FIXTURE_DETAILS;

  if (first === undefined) throw new Error("No fixtures");
  fake.publish(() => listening(rest));
  const { store } = mountTraces(fake.api);

  await screen.findAllByTestId("traces-row");
  fake.dropAll(null);
  act(() => store.setState({ hosts: [host("reconnecting", 1)] }));
  act(() => store.setState({ hosts: [host("connected", 2)] }));
  // A trace that arrives after the reconnect.
  fake.publish(() => listening(FIXTURE_DETAILS));

  await waitFor(
    () =>
      expect(
        document.querySelector(`[data-testid="traces-row"][data-trace="${first.summary.id}"]`)
      ).not.toBeNull(),
    { timeout: 500 }
  );
});

test("finding 2: an open trace that is still receiving spans shows the new spans", async () => {
  const full = detailOf(ERROR_TRACE.id);
  const early: TraceDetail = {
    summary: { ...full.summary, spans: 3 },
    spans: full.spans.slice(0, 3),
  };
  let now: ReadonlyArray<TraceDetail> = [early];
  const fake = scripted(() => now);

  fake.publish(() => listening(now));
  mountTraces(fake.api);
  fireEvent.click(await screen.findByRole("button", { name: /^test overdue-totals/ }));
  expect((await screen.findByTestId("waterfall-ended")).textContent).toContain("3 spans");

  // The exporter's next batch: the summary the sidebar shows grows to 6 spans.
  now = [full];
  fake.publish(() => listening(now));

  await waitFor(
    () => expect(screen.getByTestId("waterfall-ended").textContent).toContain("6 spans"),
    { timeout: 500 }
  );
});

test("finding 3: the receiver going Unavailable still lets the listed traces open", async () => {
  const fake = scripted(() => FIXTURE_DETAILS);

  fake.publish(() => ({
    ...listening(FIXTURE_DETAILS),
    availability: {
      _tag: "Unavailable",
      code: "E-TRACE-PORT-IN-USE",
      message: "Port 4319 is in use",
      owner: "otelcol-contrib (pid 4127)",
    },
  }));
  mountTraces(fake.api);
  fireEvent.click(await screen.findByRole("button", { name: /^POST \/invoices\/overdue, 840/ }));

  await waitFor(() => expect(screen.queryByTestId("waterfall")).not.toBeNull(), {
    timeout: 500,
  });
});

test("finding 5: exception frames in ⌘5's span panel open in the Editor", async () => {
  const fixtures = fixtureTracesApi();
  const fake = scripted(() => FIXTURE_DETAILS);

  fake.publish(() => listening(FIXTURE_DETAILS));
  act(() => {
    selectTrace(AT, ERROR_TRACE.id);
    selectSpan(AT, "3c5d7e9f1a2b4c6d");
  });
  mountTraces({ ...fake.api, span: fixtures.span });

  fireEvent.click(await screen.findByRole("tab", { name: /Events/ }));
  const exception = await screen.findByTestId("span-exception");
  const [own] = within(exception).getAllByTestId("span-frame");

  expect(own?.dataset.inProject).toBe("true");
  expect(within(own ?? exception).queryByTestId("file-link")).not.toBeNull();
});

test("finding 6: a ×214 repeat, once listed, can be folded again", async () => {
  const fake = scripted(() => FIXTURE_DETAILS);

  fake.publish(() => listening(FIXTURE_DETAILS));
  act(() => selectTrace(AT, BIG_TRACE.id));
  mountTraces(fake.api);

  const [fold] = await screen.findAllByRole("button", { name: "List each of the 214 calls" });

  fireEvent.click(fold ?? document.body);

  const refold = screen
    .queryAllByRole("button")
    .filter((b) => /214/.test(`${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`));

  expect(refold.length).toBeGreaterThan(0);
});

test("control: the harness lists the fixtures and opens a trace in the waterfall", async () => {
  const fake = scripted(() => FIXTURE_DETAILS);

  fake.publish(() => listening(FIXTURE_DETAILS));
  mountTraces(fake.api);
  fireEvent.click(await screen.findByRole("button", { name: /^POST \/invoices\/overdue, 840/ }));

  expect((await screen.findByTestId("waterfall-ended")).textContent).toContain("434 spans");
});

test("finding 8: another session's Turn 12 in the same checkout isn't this session's NOW", () => {
  const [mine, theirs] = FIXTURE_DETAILS.filter((d) => d.summary.turn?.number === 12);

  if (mine === undefined || theirs === undefined) throw new Error("No Turn 12 fixtures");
  const other = {
    ...theirs.summary,
    sessionId: SessionId.make("s-other-agent"),
    turn: { sessionId: SessionId.make("s-other-agent"), id: TurnId.make("t-other-12"), number: 12 },
  };

  mountTraces(
    scripted(() => []).api,
    <TraceList traces={[mine.summary, other]} openId={null} latestTurn={12} onOpen={() => {}} />
  );

  const kickers = screen.getAllByText(/^TURN 12/).map((k) => k.textContent);

  expect(kickers.filter((k) => k?.includes("NOW"))).toHaveLength(1);
});

test("finding 9: Output's Traces tab counts an earlier Turn's traces after 200 newer ones", () => {
  const [old] = FIXTURE_DETAILS.filter((d) => d.summary.turn?.number === 10);

  if (old === undefined) throw new Error("No Turn 10 fixture");
  // A dev server between Turns: 200 health checks, all newer than Turn 10's trace.
  const newer = Array.from({ length: 200 }, (_, i) => ({
    ...old.summary,
    id: `${i.toString(16).padStart(8, "0")}${"f".repeat(24)}`,
    root: "GET /health",
    turn: null,
    startTimeUnixNano: (BigInt(old.summary.startTimeUnixNano) + BigInt(i + 1) * 1_000_000_000n).toString(),
  }));
  const all = [...newer.toReversed(), old.summary];
  const api = {
    ...scripted(() => []).api,
    watch: (_at: unknown, filter: TraceFilter | undefined, on: { next: (s: TracesSnapshot) => void }) => {
      const matched = all.filter(
        (t) => filter?.turn === undefined || (t.turn !== null && t.turn.id === filter.turn)
      );

      on.next({ ...listening([]), traces: matched.slice(0, filter?.limit ?? 50), total: matched.length });

      return () => undefined;
    },
  };
  const { wrapper } = providers(api);
  const { result } = renderHook(
    () => useTurnTraces(AT.hostKey, AT.sessionId, [old.summary.turn?.id ?? ""]),
    { wrapper }
  );

  expect(result.current?.total ?? 0).toBe(1);
});
