/** The View menu's commands: the four views, the output rail, and word wrap; part of KEYMAP. */
import type { KeyBinding } from "./keymap.ts";

export type ViewCommandId =
  | "view.orchestrate"
  | "view.review"
  | "view.edit"
  | "view.data"
  | "view.output"
  | "view.wordWrap";

/** The id the menu's Word wrap checkbox runs; it is drawn by menuTemplate, not from `menu`. */
export const WORD_WRAP: ViewCommandId = "view.wordWrap";

export const VIEW_BINDINGS: ReadonlyArray<KeyBinding> = [
  {
    id: "view.orchestrate",
    title: "Orchestrate",
    keys: ["CmdOrCtrl+1"],
    menu: "View",
    palette: { group: "app", title: "Go to Orchestrate", keywords: ["view", "mode"] },
  },
  {
    id: "view.review",
    title: "Review",
    keys: ["CmdOrCtrl+2"],
    menu: "View",
    palette: { group: "app", title: "Go to Review", keywords: ["view", "mode", "diff"] },
  },
  {
    id: "view.edit",
    title: "Edit",
    keys: ["CmdOrCtrl+3"],
    menu: "View",
    palette: { group: "app", title: "Go to Edit", keywords: ["view", "mode", "editor"] },
  },
  {
    id: "view.data",
    title: "Data",
    keys: ["CmdOrCtrl+4"],
    menu: "View",
    palette: {
      group: "app",
      title: "Go to Data",
      keywords: ["view", "mode", "database", "sql", "query", "table"],
    },
  },
  {
    id: "view.output",
    title: "Show or hide output",
    keys: ["CmdOrCtrl+Alt+B"],
    menu: "View",
    palette: { group: "workspace", keywords: ["changes", "diff", "panel", "rail"] },
  },
  {
    id: WORD_WRAP,
    title: "Word wrap",
    keys: ["Alt+Z"],
    palette: {
      group: "app",
      title: "Toggle word wrap",
      keywords: ["wrap", "lines", "long", "soft wrap", "diff", "editor"],
    },
  },
];
