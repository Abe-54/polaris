import "../../../test/dom.testing.ts";
import { Capability, HostId, TurnId } from "@polaris/protocol";
import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { createStore } from "zustand/vanilla";
import type { HostView } from "../../../../shared/api.ts";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, initialState } from "../../../store/store.ts";
import { type TracesApi, TracesLayer, tracesSelection } from "../../traces/index.ts";
import { fixtureTracesApi } from "../../traces/preview/fixtureApi.ts";
import { FIXTURE_DETAILS, FIXTURE_SESSION } from "../../traces/preview/fixtures.ts";
import type { ReviewTurn, TurnPick } from "../data/source.ts";
import { openSchemaDiff, schemaPaneStore } from "../schema/store.ts";
import { closeTracesCompare, openTracesCompare, tracesPaneStore } from "./store.ts";
import { TracesCompareBody } from "./TracesCompareBody.tsx";
import { useReviewTraces } from "./useReviewTraces.ts";

afterEach(cleanup);

const host = (capabilities: ReadonlyArray<Capability>): HostView => ({
  key: "local",
  label: "Mac Studio",
  colour: null,
  alias: null,
  kind: "local",
  proofHarness: false,
  status: {
    state: "connected",
    failure: null,
    attempt: 0,
    since: 0,
    nextAttemptAt: null,
    host: {
      hostId: HostId.make("h"),
      hostname: "studio",
      platform: "darwin-arm64",
      daemonVersion: "0.0.0",
      homeDir: "/Users/lucas",
      startedAt: "2026-10-31T00:00:00.000Z",
    },
    capabilities,
    epoch: 1,
    latencyMs: null,
    lastSeenAt: null,
  },
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

const PICK_12: TurnPick = { kind: "turn", turnId: TurnId.make("t-overdue-12") };

const mount = (capabilities: ReadonlyArray<Capability>) => {
  const store = createStore<AppState>(() => ({ ...initialState, hosts: [host(capabilities)] }));
  const navigation = createNavigation({ app: store, storage: null });
  const compares: Array<unknown> = [];
  const base = fixtureTracesApi();

  const api: TracesApi = {
    ...base,
    compare: (at, a, b) => {
      compares.push([a, b]);

      return base.compare(at, a, b);
    },
  };

  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppProvider
      value={{
        connection: {
          store,
          openSession: () => () => undefined,
          setDensity: () => undefined,
          setAppearance: () => undefined,
        },
        navigation,
        commands: createCommandRegistry({ platform: "mac" }),
      }}
    >
      <TracesLayer api={api}>{children}</TracesLayer>
    </AppProvider>
  );

  const hook = renderHook(
    () =>
      useReviewTraces({
        hostKey: "local",
        sessionId: FIXTURE_SESSION,
        host: store.getState().hosts[0],
        turns: TURNS,
        pending: TURNS,
        pick: PICK_12,
        views: [],
      }),
    { wrapper }
  );

  return { ...hook, compares, navigation };
};

describe("Review's route timings", () => {
  test("a Daemon without traces.compare is never asked and shows no section", () => {
    const { result, compares } = mount(Capability.literals.filter((c) => c !== "traces.compare"));

    expect(compares).toEqual([]);
    expect(result.current).toBeNull();
  });

  test("a picked Turn compares with the Turn before it, biggest slowdown first", async () => {
    const { result } = mount(Capability.literals);

    await waitFor(() => expect(result.current?.answer.status).toBe("ready"));
    const answer = result.current?.answer;

    expect(answer?.status === "ready" ? answer.caption : null).toBe("Turn 12 against turn 11");
    expect(answer?.status === "ready" ? answer.rows.map((r) => [r.route, r.change]) : null).toEqual(
      [
        ["POST /invoices/overdue", "compared"],
        ["test overdue-totals", "compared"],
        ["GET /customers/:id", "no-baseline"],
        ["GET /invoices?status=overdue", "no-baseline"],
      ]
    );
  });

  test("a route opens Traces at its Turn's newest trace of that route", async () => {
    const { result, navigation } = mount(Capability.literals);

    await waitFor(() => expect(result.current?.answer.status).toBe("ready"));
    const answer = result.current?.answer;
    const row = answer?.status === "ready" ? answer.rows[0] : undefined;

    if (row === undefined) throw new Error("no route");
    act(() => result.current?.onOpenRoute(row));

    const expected = FIXTURE_DETAILS.find(
      (d) => d.summary.turn?.number === 12 && d.summary.root === "POST /invoices/overdue"
    )?.summary.id;

    expect(navigation.store.getState().mode).toBe("traces");
    expect(tracesSelection({ hostKey: "local", sessionId: FIXTURE_SESSION }).traceId).toBe(
      expected ?? "missing"
    );
  });
});

describe("the Route timings body", () => {
  const plan = {
    before: { turnId: TurnId.make("t-overdue-11"), number: 11 },
    after: { turnId: TurnId.make("t-overdue-12"), number: 12 },
  };

  test("a row opens its route; no baseline says so", () => {
    const opened: Array<string> = [];

    const view = render(
      <TracesCompareBody
        plan={plan}
        onOpenRoute={(row) => opened.push(row.route)}
        answer={{
          status: "ready",
          caption: "Turn 12 against turn 11",
          rows: [
            {
              key: "a",
              service: "ledger-api",
              route: "GET /customers/:id",
              change: "no-baseline",
              before: null,
              after: { p50Ms: 38, p95Ms: 38, count: 1 },
              ratio: null,
            },
          ],
        }}
      />
    );

    const route = view.getByTestId("traces-route");

    expect(route.textContent).toContain("no baseline");
    fireEvent.click(route);
    expect(opened).toEqual(["GET /customers/:id"]);
  });

  test("a failed comparison gives the Daemon's reason", () => {
    const view = render(
      <TracesCompareBody
        plan={plan}
        onOpenRoute={() => undefined}
        answer={{ status: "failed", message: "Traces are unavailable on this host" }}
      />
    );

    expect(view.getByText("Route timings unavailable")).not.toBeNull();
    expect(view.getByText("Traces are unavailable on this host")).not.toBeNull();
  });
});

test("Route timings and a Schema Diff take the diff pane in turn", () => {
  openTracesCompare("s");
  openSchemaDiff("s", "src-app");
  expect([tracesPaneStore.getState().open.has("s"), schemaPaneStore.getState().open.s]).toEqual([
    false,
    "src-app",
  ]);

  openTracesCompare("s");
  expect([tracesPaneStore.getState().open.has("s"), schemaPaneStore.getState().open.s]).toEqual([
    true,
    undefined,
  ]);
  closeTracesCompare("s");
});
