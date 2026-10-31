/** The real ⌘5 Traces mode (TracesMode) on a scriptable TracesApi and app store, for tests. */
import "../../../test/dom.testing.ts";
import "../../../app/slots.tsx";
import {
  AgentSession,
  Capability,
  type ConnectionState,
  HostId,
  Sequence,
  SessionSummary,
  type TraceDetail,
  type TraceFilter,
  type TracesSnapshot,
  Workspace,
  TraceAvailability,
} from "@polaris/protocol";
import { TooltipProvider } from "@polaris/ui";
import { act, render } from "@testing-library/react";
import { createStore } from "zustand/vanilla";
import { afterAll, beforeAll } from "bun:test";
import type { ReactNode } from "react";
import type { HostView, IpcError } from "../../../../shared/api.ts";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { modelFromSnapshot } from "../../../store/hostModel.ts";
import { type AppState, type Connection, initialState } from "../../../store/store.ts";
import { DataLayer } from "../../data/data/hooks.tsx";
import { fixtureDataApi } from "../../data/preview/fixtureApi.ts";
import type { Snapshots, TracesApi } from "../data/api.ts";
import { TracesLayer } from "../data/hooks.tsx";
import { FIXTURE_CHECKOUT, FIXTURE_SESSION } from "../preview/fixtures.ts";
import { TracesMode } from "./TracesMode.tsx";

export const HOST = "local";

export const AT = { hostKey: HOST, sessionId: FIXTURE_SESSION };

const NOW = "2026-10-31T14:03:00.000Z";

export const host = (state: ConnectionState = "connected", epoch = 1): HostView => ({
  key: HOST,
  label: "Mac Studio",
  colour: null,
  alias: null,
  kind: "local",
  proofHarness: false,
  status: {
    state,
    failure: null,
    attempt: state === "connected" ? 0 : 2,
    since: 0,
    nextAttemptAt: null,
    host: {
      hostId: HostId.make("h-studio"),
      hostname: "studio",
      platform: "darwin-arm64",
      daemonVersion: "0.0.0",
      homeDir: "/Users/lucas",
      startedAt: "2026-10-31T00:00:00.000Z",
    },
    capabilities: Capability.literals,
    epoch,
    latencyMs: null,
    lastSeenAt: null,
  },
});

const appState = (): AppState => ({
  ...initialState,
  density: "calm",
  hosts: [host()],
  hostsListed: true,
  hostModels: {
    [HOST]: modelFromSnapshot({
      sequence: Sequence.make(1),
      workspaces: [
        new Workspace({
          id: FIXTURE_CHECKOUT.workspaceId,
          path: "/Users/lucas/code/ledger",
          name: "ledger",
          isGitRepo: true,
          worktreeRoot: "/Users/lucas/code/ledger.worktrees",
          hidden: false,
          registeredAt: NOW,
        }),
      ],
      worktrees: [],
      sessions: [
        new SessionSummary({
          session: new AgentSession({
            id: FIXTURE_SESSION,
            workspaceId: FIXTURE_CHECKOUT.workspaceId,
            harness: "claude",
            title: "Fix overdue totals",
            cwd: FIXTURE_CHECKOUT.checkout,
            worktreeId: null,
            state: "idle",
            permissionMode: "supervised",
            model: null,
            effort: null,
            parentSessionId: null,
            forkedFromTurnId: null,
            harnessCursor: null,
            turnCount: 12,
            contextUsage: null,
            lastError: null,
            createdAt: NOW,
            updatedAt: NOW,
          }),
          pendingApprovals: [],
          lastTurnPreview: null,
          subagents: [],
        }),
      ],
    }),
  },
});

/** One open `traces.watch`, which the test can push snapshots into or end. */
export interface OpenWatch {
  readonly filter: TraceFilter | undefined;
  readonly on: Snapshots;
  closed: boolean;
}

/** A TracesApi the test drives: every watch is recorded; `get` answers from `details`. */
export const scripted = (details: () => ReadonlyArray<TraceDetail>) => {
  const watches: Array<OpenWatch> = [];
  const gets: Array<string> = [];

  let snapshot: (filter: TraceFilter | undefined) => TracesSnapshot = () => ({
    availability: TraceAvailability.cases.Listening.make({}),
    userExported: false,
    endpoint: null,
    traces: [],
    total: 0,
  });

  const api: TracesApi = {
    watch: (_at, filter, on) => {
      const watch: OpenWatch = { filter, on, closed: false };

      watches.push(watch);
      on.next(snapshot(filter));

      return () => {
        watch.closed = true;
      };
    },
    get: (_at, traceId) => {
      gets.push(traceId);
      const found = details().find((d) => d.summary.id.startsWith(traceId));

      return Promise.resolve(
        found === undefined
          ? { ok: false, error: { code: "E-TRACE-NOT-FOUND", message: "No trace", fix: "" } }
          : { ok: true, value: found }
      );
    },
    span: () =>
      Promise.resolve({ ok: false, error: { code: "E-TRACE-NOT-FOUND", message: "No span" } }),
  };

  return {
    api,
    watches,
    gets,
    /** Sets what new watches get and pushes it into every open one. */
    publish: (next: (filter: TraceFilter | undefined) => TracesSnapshot) => {
      snapshot = next;
      act(() => {
        for (const w of watches) if (!w.closed) w.on.next(next(w.filter));
      });
    },
    /** Ends every open watch, as the main process does when the connection drops. */
    dropAll: (error: IpcError | null) =>
      act(() => {
        for (const w of watches)
          if (!w.closed) {
            w.closed = true;
            w.on.end?.(error);
          }
      }),
  };
};

/** The app's providers over `api`, with the Traces session selected in ⌘5. */
export const providers = (api: TracesApi) => {
  const store = createStore<AppState>(() => appState());

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  const navigation = createNavigation({ app: store, storage: null });

  navigation.actions.selectSession(AT);
  navigation.actions.setMode("traces");

  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppProvider
      value={{ connection, navigation, commands: createCommandRegistry({ platform: "mac" }) }}
    >
      <TooltipProvider>
        <DataLayer api={fixtureDataApi()}>
          <TracesLayer api={api}>{children}</TracesLayer>
        </DataLayer>
      </TooltipProvider>
    </AppProvider>
  );

  return { store, navigation, wrapper };
};

export const mountTraces = (api: TracesApi, children: ReactNode = <TracesMode />) => {
  const { store, navigation, wrapper: Wrapper } = providers(api);
  const view = render(<Wrapper>{children}</Wrapper>);

  return { view, store, navigation };
};

const KEYS = ["offsetWidth", "offsetHeight"] as const;

/** happy-dom has no layout: a tall scroller, so the virtualised waterfall renders its rows. */
export const useLayout = () => {
  const saved = KEYS.map(
    (key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)] as const
  );

  beforeAll(() => {
    for (const key of KEYS)
      Object.defineProperty(HTMLElement.prototype, key, {
        configurable: true,
        get(this: HTMLElement) {
          if (key === "offsetWidth") return 900;

          return this.hasAttribute("data-index") ? 28 : 4000;
        },
      });
  });

  afterAll(() => {
    for (const [key, descriptor] of saved)
      if (descriptor !== undefined) Object.defineProperty(HTMLElement.prototype, key, descriptor);
  });
};
