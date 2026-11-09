/** Requests' commands (⌘6): send and save the open Request; part of KEYMAP. */
import type { KeyBinding } from "./keymap.ts";

export type RequestsCommandId = "requests.send" | "requests.save";

export const REQUESTS_BINDINGS: ReadonlyArray<KeyBinding> = [
  // Only in Requests: the open Request as edited, unsaved edits included.
  {
    id: "requests.send",
    title: "Send request",
    keys: ["CmdOrCtrl+Enter"],
    when: "mode.requests",
    palette: { group: "workspace", keywords: ["requests", "http", "send", "run"] },
  },
  // Only in Requests, with unsaved edits; Edit's Save file keeps ⌘S elsewhere.
  {
    id: "requests.save",
    title: "Save request",
    keys: ["CmdOrCtrl+S"],
    shares: "editor.save",
    when: "mode.requests",
    palette: { group: "workspace", keywords: ["requests", "http", "save", "write"] },
  },
];
