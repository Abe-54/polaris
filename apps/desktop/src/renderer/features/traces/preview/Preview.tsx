/**
 * Traces on fixtures, for screenshots: `#traces/<scene>` (traces, empty, unavailable,
 * userExported; `?view=profile` and others in views.ts) renders the whole app on Traces with "Fix
 * overdue totals" in the ledger Workspace selected, its TracesApi the scene's, no Daemon involved.
 * `settings` and `page` pick the Workspace's Traces settings and open Settings → Traces (settings.ts).
 */
import { createRoot } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import { App } from "../../../app/App.tsx";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import type { AppState, Connection } from "../../../store/store.ts";
import { DataLayer } from "../../data/data/hooks.tsx";
import { fixtureDataApi } from "../../data/preview/fixtureApi.ts";
import { TracesLayer } from "../data/hooks.tsx";
import { ProfilesLayer } from "../data/profiles.tsx";
import { fixtureAppState, HOST, host } from "./appState.ts";
import { fixtureTracesApi } from "./fixtureApi.ts";
import { withLargeTrace } from "./large.ts";
import { TracesSettingsLayer } from "../settings/hooks.tsx";
import { FIXTURE_SESSION, FIXTURE_SNAPSHOTS, type TracesScene } from "./fixtures.ts";
import { opensSettings, previewSettingsApi } from "./settings.ts";
import {
  isStateView,
  openViewSpan,
  previewOf,
  type PreviewView,
  silent,
  viewProfilesApi,
} from "./views.ts";

const appState = (view: PreviewView): AppState =>
  fixtureAppState(
    view === "reconnecting" || view === "offline" || view === "needs-attention"
      ? { ...host, status: { ...host.status, state: view, attempt: 2 } }
      : host
  );

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
    <TracesLayer api={view !== null && isStateView(view) ? silent(api) : api}>
      <ProfilesLayer api={viewProfilesApi(view)}>
        <TracesSettingsLayer api={previewSettingsApi(hash)}>
          <DataLayer api={fixtureDataApi()}>
            <App
              value={{
                connection,
                navigation,
                commands: createCommandRegistry({ platform: "mac" }),
              }}
            />
          </DataLayer>
        </TracesSettingsLayer>
      </ProfilesLayer>
    </TracesLayer>
  );

  return connection.setDensity;
};
