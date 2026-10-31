/** Traces' commands (⌘5): the open trace to the agent session; part of KEYMAP. */
import type { KeyBinding } from "./keymap.ts";

export type TracesCommandId = "traces.addToSession";

export const TRACES_BINDINGS: ReadonlyArray<KeyBinding> = [
  // Only in Traces with a trace open: it, and the selected span, to the shown session's draft.
  {
    id: "traces.addToSession",
    title: "Add trace to agent session",
    keys: ["CmdOrCtrl+L"],
    shares: "session.focusComposer",
    when: "mode.traces",
    palette: { group: "workspace", keywords: ["traces", "span", "attach"] },
  },
];
