/**
 * Data mode's sidebar, connection bar and status bar on fixtures, for screenshots against
 * Paper D1/D3: `#data-sidebar/<scene>` renders the real shell in Data. Its own chunk.
 */
import type { ConnectionState } from "@polaris/protocol";
import { createRoot } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import { App } from "../../../app/App.tsx";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { type AppState, type Connection, initialState } from "../../../store/store.ts";
import type { DataApi } from "../data/api.ts";
import { DataLayer } from "../data/hooks.tsx";
import { openSourceForm, setSidebarView } from "../model/sidebar.ts";
import { openSqlTab, openTable } from "../model/store.ts";
import { fixtureDataApi } from "./fixtureApi.ts";
import { DATA_AT, DATA_WORKSPACE_ID, dataHost, dataHostModel } from "./scene.ts";
import { REPLICA, WORST_LONG_TABLE, worstCaseDataApi } from "./worstCase.ts";

const SCENES = [
  "worst",
  "card",
  "log",
  "form",
  "empty",
  "unreachable",
  "reconnecting",
  "offline",
] as const;

type Scene = (typeof SCENES)[number];

const apiFor = (scene: Scene): DataApi =>
  scene === "empty" ? fixtureDataApi({ sources: [] }) : worstCaseDataApi();

const stateOf = (scene: Scene): ConnectionState =>
  scene === "reconnecting" || scene === "offline" ? scene : "connected";

/** What each scene opens once Data has mounted; "card" is opened by the screenshot script. */
const prepare = (scene: Scene) => {
  if (scene === "empty") return;

  if (scene === "unreachable") {
    openSqlTab("select * from documents limit 50", "search", DATA_AT);

    return;
  }

  openTable(REPLICA.name, WORST_LONG_TABLE, DATA_AT);

  if (scene === "log") setSidebarView(DATA_AT, "log");

  if (scene === "form") openSourceForm(DATA_AT, { mode: "add" });
};

const sceneOf = (hash: string): Scene => {
  const name = hash.replace(/^#data-sidebar\//, "");

  return SCENES.find((s) => s === name) ?? "worst";
};

export const mountDataSidebarPreview = (root: HTMLElement, hash: string) => {
  const scene = sceneOf(hash);

  const store = createStore<AppState>(() => ({
    ...initialState,
    hosts: [dataHost(stateOf(scene))],
    hostModels: { [DATA_AT.hostKey]: dataHostModel() },
  }));

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: (density) => store.setState({ density }),
    setAppearance: ({ density, theme }) => store.setState({ density, theme }),
  };

  const navigation = createNavigation({ app: store, storage: null });

  navigation.actions.selectWorkspace({ hostKey: DATA_AT.hostKey, workspaceId: DATA_WORKSPACE_ID });
  navigation.actions.selectSession(DATA_AT);
  navigation.actions.setMode("data");

  createRoot(root).render(
    <DataLayer api={apiFor(scene)}>
      <App
        value={{ connection, navigation, commands: createCommandRegistry({ platform: "mac" }) }}
      />
    </DataLayer>
  );

  setTimeout(() => prepare(scene), 100);

  return connection.setDensity;
};
