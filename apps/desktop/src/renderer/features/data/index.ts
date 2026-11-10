/**
 * Data mode (⌘4; DESIGN.md, Data; ENG-644): the layout, the tab model and registry, and the
 * hooks over the Data IPC contract. The interface for the shell and other features.
 */
export { DataMode, dataChunk } from "./ui/LazyDataMode.tsx";

export {
  closeDataTab,
  type DataSessionKey,
  focusDataTab,
  openSqlTab,
  openTable,
  useDataTabs,
} from "./model/store.ts";

export type { DataTab, DataTabKind } from "./model/tabs.ts";

export {
  DataLayer,
  type Loaded,
  useDataApi,
  useDataSources,
  useDescribe,
  useQueryLog,
} from "./data/hooks.tsx";

export type { DataApi } from "./data/api.ts";
