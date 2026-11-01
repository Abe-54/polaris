/** Data's commands (⌘4): rows to the agent session, a new SQL tab, committing staged edits; part of KEYMAP. */
import type { KeyBinding } from "./keymap.ts";

export type DataCommandId = "data.addRowsToSession" | "data.newSqlTab" | "data.commitEdits";

export const DATA_BINDINGS: ReadonlyArray<KeyBinding> = [
  // Only in Data, on a grid's rows: the selected rows, or all shown, to the shown session.
  {
    id: "data.addRowsToSession",
    title: "Add rows to agent session",
    keys: ["CmdOrCtrl+L"],
    shares: "session.focusComposer",
    palette: { group: "workspace", keywords: ["data", "table", "rows", "attach"] },
  },
  // Only in Data: a new SQL tab on the open tab's Data Source.
  {
    id: "data.newSqlTab",
    title: "New SQL tab",
    keys: ["CmdOrCtrl+T"],
    when: "mode.data",
    palette: { group: "workspace", keywords: ["data", "query", "sql"] },
  },
  // Only in Data, with edits staged in the shown Table tab; Edit's Save file keeps ⌘S elsewhere.
  {
    id: "data.commitEdits",
    title: "Commit staged changes",
    keys: ["CmdOrCtrl+S"],
    shares: "editor.save",
    when: "mode.data",
    palette: { group: "workspace", keywords: ["data", "table", "edit", "save", "write"] },
  },
];
