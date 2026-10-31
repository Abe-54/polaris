/**
 * Traces on fixtures, for screenshots: `#traces/<scene>` (traces, empty, unavailable,
 * userExported) renders the whole app on Traces with "Fix overdue totals" in the ledger
 * Workspace selected, its TracesApi the scene's, no Daemon involved. `settings` and `page` pick
 * the Workspace's Traces settings and open Settings → Traces (settings.ts).
 */
import {
  AgentSession,
  Capability,
  HostId,
  Sequence,
  SessionSummary,
  Workspace,
} from "@polaris/protocol";
import { createRoot } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import type { HostView } from "../../../../shared/api.ts";
import { App } from "../../../app/App.tsx";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { modelFromSnapshot } from "../../../store/hostModel.ts";
import { type AppState, type Connection, initialState } from "../../../store/store.ts";
import { DataLayer } from "../../data/data/hooks.tsx";
import { fixtureDataApi } from "../../data/preview/fixtureApi.ts";
import { TracesLayer } from "../data/hooks.tsx";
import { fixtureTracesApi } from "./fixtureApi.ts";
import { withLargeTrace } from "./large.ts";
import { opensSettings, previewSettingsApi } from "./settings.ts";
import { TracesSettingsLayer } from "../settings/hooks.tsx";
import {
  FIXTURE_CHECKOUT,
  FIXTURE_SESSION,
  FIXTURE_SNAPSHOTS,
  type TracesScene,
} from "./fixtures.ts";
import { openViewSpan, previewOf, type PreviewView, silent } from "./views.ts";

const HOST = "local";

const NOW = "2026-10-31T14:03:00.000Z";

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
      startedAt: "2026-10-31T00:00:00.000Z",
    },
    capabilities: Capability.literals,
    epoch: 1,
    latencyMs: null,
    lastSeenAt: null,
  },
};

const appState = (view: PreviewView): AppState => ({
  ...initialState,
  hosts: [
    view === "reconnecting"
      ? { ...host, status: { ...host.status, state: "reconnecting", attempt: 2 } }
      : host,
  ],
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

const isScene = (name: string): name is TracesScene => Object.hasOwn(FIXTURE_SNAPSHOTS, name);

const sceneOf = (hash: string): TracesScene => {
  const { name } = previewOf(hash);

  return isScene(name) ? name : "traces";
};

/** `shown` is the appearance at mount: later changes arrive through the returned setter. */
export const mountTracesPreview = (
  root: HTMLElement,
  hash: string,
  shown: Pick<AppState, "density" | "theme">
) => {
  const { view } = previewOf(hash);
  const store = createStore<AppState>(() => ({ ...appState(view), ...shown }));
  const api = withLargeTrace(hash, fixtureTracesApi(sceneOf(hash)));

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: (density) => store.setState({ density }),
    setAppearance: ({ density, theme }) => store.setState({ density, theme }),
  };

  const navigation = createNavigation({ app: store, storage: null });

  navigation.actions.selectSession({ hostKey: HOST, sessionId: FIXTURE_SESSION });
  navigation.actions.setMode("traces");
  openViewSpan({ hostKey: HOST, sessionId: FIXTURE_SESSION }, view);

  if (opensSettings(hash)) navigation.actions.openSettings("traces");

  createRoot(root).render(
    <TracesLayer api={view === "loading" || view === "reconnecting" ? silent(api) : api}>
      <TracesSettingsLayer api={previewSettingsApi(hash)}>
        <DataLayer api={fixtureDataApi()}>
          <App
            value={{ connection, navigation, commands: createCommandRegistry({ platform: "mac" }) }}
          />
        </DataLayer>
      </TracesSettingsLayer>
    </TracesLayer>
  );

  return connection.setDensity;
};
