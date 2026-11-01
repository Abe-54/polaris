/**
 * Data mode's sidebar, connection bar and status bar on fixtures, for screenshots against
 * Paper D1/D3: `#data-sidebar/<scene>` renders the real shell in Data. Its own chunk.
 */
import { type ConnectionState, DataSource } from "@polaris/protocol";
import { Schema } from "effect";
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
  "gone",
  "params",
  "narrow",
  "manual",
  "edit",
  "name",
  "keys",
] as const;

type Scene = (typeof SCENES)[number];

/** A source the user added: a remote with a 40-character red label, not approved yet. */
const MANUAL = new DataSource({
  ...Schema.encodeSync(DataSource)(REPLICA),
  id: "src-manual-billing-primary",
  name: "billing-primary",
  host: "billing-primary.eu-central-1.rds.example.com",
  foundIn: { kind: "manual" },
  access: "needs-approval",
  label: { text: "PRODUCTION · BILLING · EU-CENTRAL-1 · PRI", colour: "red" },
});

const WITH_MANUAL: ReadonlyArray<Scene> = ["narrow", "manual", "edit"];

const apiFor = (scene: Scene): DataApi => {
  if (scene === "empty") return fixtureDataApi({ sources: [] });

  return worstCaseDataApi(WITH_MANUAL.includes(scene) ? [MANUAL] : []);
};

const stateOf = (scene: Scene): ConnectionState =>
  scene === "reconnecting" || scene === "offline" ? scene : "connected";

/** The scenes that open one SQL tab, by what it holds. */
const SQL_SCENES: Partial<Record<Scene, Parameters<typeof openSqlTab>>> = {
  unreachable: ["select * from documents limit 50", "search", DATA_AT],
  gone: ["select count(*) from page_views", "warehouse-old", DATA_AT],
  params: [
    "select * from invoices where customer_id = $1 and status = $2",
    "billing",
    DATA_AT,
    ["c-42", "overdue"],
  ],
};

/** What each scene opens once Data has mounted; the script opens cards and types. */
const prepare = (scene: Scene) => {
  if (scene === "empty") return;
  const sql = SQL_SCENES[scene];

  if (sql !== undefined) return openSqlTab(...sql);

  if (WITH_MANUAL.includes(scene))
    openTable(MANUAL.name, { schema: "public", name: "invoices" }, DATA_AT);
  else openTable(REPLICA.name, { schema: "public", name: WORST_LONG_TABLE }, DATA_AT);

  if (scene === "log") setSidebarView(DATA_AT, "log");

  if (scene === "form" || scene === "name") openSourceForm(DATA_AT, { mode: "add" });

  if (scene === "edit") openSourceForm(DATA_AT, { mode: "edit", source: MANUAL });
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
