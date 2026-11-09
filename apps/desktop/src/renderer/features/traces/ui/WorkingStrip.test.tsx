/** The Working strip under the trace bar and Follow (ENG-689), on ⌘5 over a scripted TracesApi. */
import { type TraceSummary, TraceAvailability, type TracesSnapshot } from "@polaris/protocol";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import type { StoreApi } from "zustand/vanilla";
import type { AppState } from "../../../store/store.ts";
import { setFollow } from "../model/follow.ts";
import { selectTrace, tracesSelection } from "../model/store.ts";
import { FIXTURE_DETAILS, FIXTURE_SESSION } from "../preview/fixtures.ts";
import { AT, HOST, mountTraces, scripted, useLayout } from "./mode.testing.tsx";

useLayout();

afterEach(() => {
  cleanup();
  act(() => {
    selectTrace(AT, null);
    setFollow(AT, false);
  });
});

const listening = (traces: ReadonlyArray<TraceSummary>): TracesSnapshot => ({
  availability: TraceAvailability.cases.Listening.make({}),
  userExported: false,
  endpoint: null,
  traces: traces.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt)),
  total: traces.length,
});

const setState = (store: StoreApi<AppState>, state: "working" | "idle") =>
  act(() =>
    store.setState((s) => {
      const model = s.hostModels[HOST]!;
      const entry = model.sessions.get(FIXTURE_SESSION)!;
      const sessions = new Map(model.sessions);

      sessions.set(FIXTURE_SESSION, { ...entry, session: { ...entry.session, state } });

      return { hostModels: { ...s.hostModels, [HOST]: { ...model, sessions } } };
    })
  );

const summaries = FIXTURE_DETAILS.map((d) => d.summary);

const turn12 = summaries.filter(
  (t) => t.turn?.sessionId === FIXTURE_SESSION && t.turn.number === 12
);

/** A new trace of the running Turn, started after every fixture. */
const arriving = (id: string): TraceSummary => ({
  ...turn12[0]!,
  id,
  startedAt: "2030-01-01T00:00:00.000Z",
});

test("the strip says the session is working, its Harness, Turn and the Turn's trace count", async () => {
  const fake = scripted(() => FIXTURE_DETAILS);

  fake.publish(() => listening(summaries));
  const { store } = mountTraces(fake.api);

  await screen.findByTestId("traces-mode");
  expect(screen.queryByTestId("traces-working-strip")).toBeNull();

  setState(store, "working");
  const strip = await screen.findByTestId("traces-working-strip");

  expect(strip.textContent).toContain("Fix overdue totals is working");
  expect(strip.textContent).toContain(`Claude Code · turn 12 · ${turn12.length} traces`);

  setState(store, "idle");
  expect(screen.queryByTestId("traces-working-strip")).toBeNull();
});

test("Follow opens the running Turn's newest trace, then each new one as it arrives", async () => {
  if (turn12.length === 0) throw new Error("No Turn 12 fixtures");
  let listed = summaries;
  const fake = scripted(() => FIXTURE_DETAILS);

  fake.publish(() => listening(listed));
  const { store } = mountTraces(fake.api);

  setState(store, "working");
  const follow = await screen.findByTestId("traces-follow");

  expect(tracesSelection(AT).traceId).toBeNull();

  fireEvent.click(follow);
  const newest = listening(turn12).traces[0]!.id;

  await waitFor(() => expect(tracesSelection(AT).traceId).toBe(newest));

  listed = [...summaries, arriving("ab000000000000000000000000000001")];
  fake.publish(() => listening(listed));
  await waitFor(() => expect(tracesSelection(AT).traceId).toBe("ab000000000000000000000000000001"));

  // Off, a new trace leaves the open one alone.
  fireEvent.click(follow);
  listed = [...listed, arriving("ab000000000000000000000000000002")];
  fake.publish(() => listening(listed));
  expect(tracesSelection(AT).traceId).toBe("ab000000000000000000000000000001");
});
