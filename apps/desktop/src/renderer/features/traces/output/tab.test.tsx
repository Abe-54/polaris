import "../../../test/dom.testing.ts";
import "../../../app/slots.tsx";
import { Capability, HostId } from "@polaris/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { createStore } from "zustand/vanilla";
import type { HostView } from "../../../../shared/api.ts";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, initialState } from "../../../store/store.ts";
import type { TracesApi } from "../data/api.ts";
import { TracesLayer } from "../data/hooks.tsx";
import { fixtureTracesApi } from "../preview/fixtureApi.ts";
import { FIXTURE_SESSION, FIXTURE_TURNS } from "../preview/fixtures.ts";
import { setTracesOutputShown } from "./state.ts";
import { useTracesTab } from "./tab.tsx";

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

let keys = 0;

const mount = (capabilities: ReadonlyArray<Capability>, turnIds: ReadonlyArray<string>) => {
  const store = createStore<AppState>(() => ({ ...initialState, hosts: [host(capabilities)] }));
  const watches: Array<unknown> = [];
  const base = fixtureTracesApi();

  const api: TracesApi = {
    ...base,
    watch: (at, filter, on) => {
      watches.push(filter);

      return base.watch(at, filter, on);
    },
  };

  const uiKey = `ui-${++keys}`;

  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppProvider
      value={{
        connection: {
          store,
          openSession: () => () => undefined,
          setDensity: () => undefined,
          setAppearance: () => undefined,
        },
        navigation: createNavigation({ app: store, storage: null }),
        commands: createCommandRegistry({ platform: "mac" }),
      }}
    >
      <TracesLayer api={api}>{children}</TracesLayer>
    </AppProvider>
  );

  const hook = renderHook(
    ({ free }: { free: boolean }) =>
      useTracesTab(
        "local",
        FIXTURE_SESSION,
        uiKey,
        { number: 12, views: turnIds.map((id) => ({ turn: { id } })) },
        free
      ),
    { wrapper, initialProps: { free: true } }
  );

  return { ...hook, watches, uiKey };
};

test("a Daemon without traces watches nothing and shows no tab", () => {
  const { result, watches } = mount(
    Capability.literals.filter((c) => c !== "traces"),
    [FIXTURE_TURNS[12].id]
  );

  expect(watches).toEqual([]);
  expect(result.current.visible).toBe(false);
});

test("the tab shows while the Turn has traces, counting them and their errors", () => {
  const { result } = mount(Capability.literals, [FIXTURE_TURNS[12].id]);

  expect(result.current).toMatchObject({ visible: true, total: 4, errors: 1, shown: null });
});

test("a Turn with no traces has no tab", () => {
  const { result } = mount(Capability.literals, ["t-no-traces"]);

  expect(result.current.visible).toBe(false);
});

test("picked, it shows the Turn's traces until a Subagent, the Browser or Data takes Output", () => {
  const { result, rerender, uiKey } = mount(Capability.literals, [FIXTURE_TURNS[12].id]);

  act(() => setTracesOutputShown(uiKey, true));
  expect(result.current.shown?.traces.failing).toHaveLength(1);

  rerender({ free: false });
  expect(result.current.shown).toBeNull();
});
