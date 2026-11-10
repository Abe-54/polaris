/**
 * The terminal feature: a drawer of Daemon terminals per Workspace (xterm.js
 * on WebGL, fed by the `terminal` feed), and the "Open in terminal" hand-off.
 * The shell wraps a pane in `TerminalDock`; other features run commands in it.
 */
export { TerminalDock, type TerminalDockProps } from "./ui/TerminalDock.tsx";

export {
  EditorColumn,
  TerminalChip,
  TerminalPanels,
  type TerminalPanelsProps,
} from "./ui/TerminalPanels.tsx";

export { useTerminalLeaving } from "./ui/leaving.ts";

export {
  InTerminalBar,
  OpenInTerminalItem,
  openInTerminalEntry,
  type HandoffSession,
} from "./ui/InTerminal.tsx";

export { claimFocusFromMenu, keepTerminalFocus } from "./focus.ts";

export { useTerminalKey } from "./toggleKey.ts";

export {
  openShell,
  openTerminalIn,
  runInTerminal,
  toggleTerminal,
  tuckTerminal,
  type TerminalPlace,
  type TerminalRun,
} from "./actions.ts";

export { HarnessTerminal, type HarnessTerminalProps } from "./ui/HarnessTerminal.tsx";

export { isTerminalShown, useTerminalShown } from "./store.ts";
