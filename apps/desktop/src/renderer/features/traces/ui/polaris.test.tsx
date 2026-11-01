/** Self-Traces in ⌘5: the Polaris switch where no Workspace holds Polaris's code, and their label. */
import {
  type DeveloperMode,
  DeveloperMode as DeveloperModeSchema,
  TraceAvailability,
  type TraceSummary,
  WorkspaceId,
} from "@polaris/protocol";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import type { TracesApi } from "../data/api.ts";
import { TracesDeveloperModeLayer } from "../model/developerMode.ts";
import { selectTrace } from "../model/store.ts";
import { FIXTURE_DETAILS } from "../preview/fixtures.ts";
import { AT, host, mountTraces } from "./mode.testing.tsx";
import { TracesMode } from "./TracesMode.tsx";

afterEach(() => {
  cleanup();
  act(() => {
    selectTrace(AT, null);
    selectTrace({ ...AT, scope: "self" }, null);
  });
});

const CHECKOUT_TRACE = FIXTURE_DETAILS[0]!.summary;

const SELF_TRACE: TraceSummary = {
  ...CHECKOUT_TRACE,
  id: "a".repeat(31) + "1",
  root: "polaris.rpc.dispatch",
  service: "polaris-daemon",
  services: ["polaris-daemon"],
  turn: null,
  sessionId: null,
};

const mode = (options: { effective: boolean; polarisWorkspaceId?: string }) => {
  const polaris =
    options.polarisWorkspaceId === undefined ? null : WorkspaceId.make(options.polarisWorkspaceId);

  return DeveloperModeSchema.make({
    stored: options.effective,
    leases: 0,
    fromSource: false,
    effective: options.effective,
    polarisWorkspaceId: polaris,
    polarisWorkspaceSource: polaris === null ? null : "override",
  });
};

/** Answers each scope with its own Traces and records which scopes were watched. */
const scopedApi = (
  checkout: ReadonlyArray<TraceSummary> = [CHECKOUT_TRACE],
  self: ReadonlyArray<TraceSummary> = [SELF_TRACE]
) => {
  const scopes: Array<string> = [];

  const api: TracesApi = {
    watch: (at, _filter, on) => {
      scopes.push(at.scope ?? "checkout");
      const traces = at.scope === "self" ? self : checkout;

      on.next({
        availability: TraceAvailability.cases.Listening.make({}),
        userExported: false,
        endpoint: null,
        traces,
        total: traces.length,
      });

      return () => undefined;
    },
    get: () => Promise.resolve({ ok: false, error: { code: "E-TRACE-NOT-FOUND", message: "" } }),
    span: () => Promise.resolve({ ok: false, error: { code: "E-TRACE-NOT-FOUND", message: "" } }),
    compare: () => Promise.resolve({ ok: false, error: { code: "E-TRACE-NONE", message: "" } }),
  };

  return { api, scopes };
};

const mountWith = (developerMode: DeveloperMode | null, api: TracesApi) =>
  mountTraces(
    api,
    <TracesDeveloperModeLayer read={() => developerMode}>
      <TracesMode />
    </TracesDeveloperModeLayer>
  );

const rowRoots = () =>
  screen.getAllByTestId("traces-row").map((row) => row.getAttribute("data-trace"));

test("with Developer Mode on and no Polaris Workspace, the Polaris switch shows Self-Traces in place of the checkout's", async () => {
  const fake = scopedApi();
  mountWith(mode({ effective: true }), fake.api);

  await waitFor(() => expect(rowRoots()).toEqual([CHECKOUT_TRACE.id]));
  const toggle = within(screen.getByTestId("traces-polaris-switch")).getByRole("switch");

  fireEvent.click(toggle);
  await waitFor(() => expect(rowRoots()).toEqual([SELF_TRACE.id]));
  expect(fake.scopes).toContain("self");
  expect(screen.getByTestId("traces-row-self").textContent).toBe("polaris");

  fireEvent.click(toggle);
  await waitFor(() => expect(rowRoots()).toEqual([CHECKOUT_TRACE.id]));
});

test("the Polaris switch stays hidden while Developer Mode is off, unknown, or a Workspace holds Polaris", async () => {
  for (const developerMode of [
    null,
    mode({ effective: false }),
    mode({ effective: true, polarisWorkspaceId: "polaris" }),
  ]) {
    mountWith(developerMode, scopedApi().api);
    await screen.findAllByTestId("traces-row");
    expect(screen.queryByTestId("traces-polaris-switch")).toBeNull();
    cleanup();
  }
});

test("a Daemon without Self-Traces gets no Polaris switch", async () => {
  const { store } = mountWith(mode({ effective: true }), scopedApi().api);
  await screen.findAllByTestId("traces-row");
  expect(screen.getByTestId("traces-polaris-switch")).toBeTruthy();

  const older = host();

  act(() =>
    store.setState({
      hosts: [
        {
          ...older,
          status: {
            ...older.status,
            capabilities: older.status.capabilities.filter((c) => c !== "traces.self"),
          },
        },
      ],
    })
  );
  expect(screen.queryByTestId("traces-polaris-switch")).toBeNull();
});

test("in a checkout of the Polaris Workspace, Self-Traces are listed beside its own and labelled", async () => {
  mountWith(
    mode({ effective: true, polarisWorkspaceId: "polaris" }),
    scopedApi([SELF_TRACE, CHECKOUT_TRACE]).api
  );

  await waitFor(() => expect(rowRoots()).toEqual([SELF_TRACE.id, CHECKOUT_TRACE.id]));
  const labels = screen.getAllByTestId("traces-row-self");
  expect(labels).toHaveLength(1);
  expect(labels[0]!.closest("[data-trace]")?.getAttribute("data-trace")).toBe(SELF_TRACE.id);
  expect(
    screen
      .getAllByTestId("traces-row")
      .map((row) => row.getAttribute("aria-label")?.endsWith(", from Polaris"))
  ).toEqual([true, false]);
});

test("with no Self-Traces yet, the Polaris switch says so instead of offering this checkout's setup", async () => {
  mountWith(mode({ effective: true }), scopedApi([CHECKOUT_TRACE], []).api);
  await screen.findAllByTestId("traces-row");

  fireEvent.click(within(screen.getByTestId("traces-polaris-switch")).getByRole("switch"));
  await waitFor(() =>
    expect(screen.getByTestId("traces-sidebar-quiet").textContent).toBe("No self-traces yet")
  );
  expect(screen.queryByTestId("traces-setup-empty")).toBeNull();
});
