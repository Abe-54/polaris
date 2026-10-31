/**
 * Data mode on fixtures, for screenshots and the grid bench (`scripts/dataTableScreens.ts`):
 * `#data/<scene>` renders the whole app on Data with "Fix overdue totals" in the ledger
 * Workspace selected, its DataApi the scene's (scenes/), no Daemon involved.
 */
import {
  AgentSession,
  Capability,
  HostId,
  Sequence,
  SessionId,
  SessionSummary,
  Workspace,
  WorkspaceId,
} from "@polaris/protocol";
import { createRoot } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import type { HostView, PolarisApi } from "../../../../shared/api.ts";
import { App } from "../../../app/App.tsx";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { modelFromSnapshot } from "../../../store/hostModel.ts";
import { type AppState, type Connection, initialState } from "../../../store/store.ts";
import { standInBridge } from "../../bridge.ts";
import type { DataApi } from "../data/api.ts";
import { DataLayer } from "../data/hooks.tsx";
import { fixtureDataApi } from "./fixtureApi.ts";
import { FIXTURE_NOW, FIXTURE_SESSIONS } from "./fixtures.ts";
import { sceneNamed } from "./scenes/index.ts";

const HOST = "local";

const workspaceId = WorkspaceId.make("ledger");

export const PREVIEW_SESSION = FIXTURE_SESSIONS.overdue.id;

const host: HostView = {
  key: HOST,
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
      hostId: HostId.make("h-studio"),
      hostname: "studio",
      platform: "darwin-arm64",
      daemonVersion: "0.0.0",
      homeDir: "/Users/lucas",
      startedAt: "2026-10-30T00:00:00.000Z",
    },
    capabilities: Capability.literals,
    epoch: 1,
    latencyMs: null,
    lastSeenAt: null,
  },
};

const at = (minutesAgo: number) => new Date(FIXTURE_NOW - minutesAgo * 60_000).toISOString();

const session = (id: SessionId, title: string, harness: string, minutesAgo: number) =>
  new SessionSummary({
    session: new AgentSession({
      id,
      workspaceId,
      harness,
      title,
      cwd: "/Users/lucas/code/ledger",
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
      createdAt: at(300),
      updatedAt: at(minutesAgo),
    }),
    pendingApprovals: [],
    lastTurnPreview: null,
    subagents: [],
  });

const appState = (): AppState => ({
  ...initialState,
  hosts: [host],
  hostsListed: true,
  hostModels: {
    [HOST]: modelFromSnapshot({
      sequence: Sequence.make(1),
      workspaces: [
        new Workspace({
          id: workspaceId,
          path: "/Users/lucas/code/ledger",
          name: "ledger",
          isGitRepo: true,
          worktreeRoot: "/Users/lucas/code/ledger.worktrees",
          hidden: false,
          registeredAt: at(10_000),
        }),
      ],
      worktrees: [],
      sessions: [
        session(PREVIEW_SESSION, FIXTURE_SESSIONS.overdue.title, "claude", 5),
        session(FIXTURE_SESSIONS.backfill.id, FIXTURE_SESSIONS.backfill.title, "codex", 42),
      ],
    }),
  },
});

const at0 = { hostKey: HOST, sessionId: PREVIEW_SESSION };

/** data.* over the scene's DataApi, for anything that asks the bridge rather than the DataLayer. */
const bridgeFor = (api: DataApi): PolarisApi => ({
  request: (method, input) => {
    // SAFETY: the preview only answers the Data requests, whose inputs name a source.
    const data = input as { source: string; sql: string; table?: string; limit?: number };

    if (method === "data.describe")
      // SAFETY: a describe's result is data.describe's output shape.
      return api.describe(at0, data) as never;

    if (method === "data.query")
      // SAFETY: a query's result is data.query's output shape.
      return api.query(at0, data) as never;

    return Promise.resolve({ ok: false, error: { code: "Unsupported", message: "preview" } });
  },
  subscribe: (kind, _input, listener) => {
    const items = {
      // SAFETY: each snapshot is the feed's item for that kind.
      next: (value: ReadonlyArray<object>) => listener.items([value] as never),
    };

    if (kind === "data.sources.watch") return api.watchSources(at0, items);

    if (kind === "data.queryLog.watch") return api.watchQueryLog(at0, items);

    return () => undefined;
  },
  onAppEvent: () => () => undefined,
});

export const mountDataPreview = (root: HTMLElement, hash: string) => {
  const name = hash.replace(/^#data\//, "");
  const scene = sceneNamed(name) ?? sceneNamed("table");
  const api = scene?.api?.() ?? fixtureDataApi();
  const store = createStore<AppState>(() => scene?.state?.(appState()) ?? appState());

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: (density) => store.setState({ density }),
    setAppearance: ({ density, theme }) => store.setState({ density, theme }),
  };

  const navigation = createNavigation({ app: store, storage: null });

  standInBridge(bridgeFor(api));
  navigation.actions.selectSession(at0);
  navigation.actions.setMode("data");
  scene?.play?.(at0);

  createRoot(root).render(
    <DataLayer api={api}>
      <App
        value={{ connection, navigation, commands: createCommandRegistry({ platform: "mac" }) }}
      />
    </DataLayer>
  );

  return connection.setDensity;
};
