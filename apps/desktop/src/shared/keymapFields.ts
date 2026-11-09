/** Chords outside KEYMAP that fields, dialogs and the terminal drawer handle themselves. */
/** ⌃` toggles the terminal drawer (Ctrl+` on Windows and Linux); the drawer handles it. */
export const TERMINAL_TOGGLE = "Ctrl+`";

/** Keys a field or dialog handles itself, so their hints read the platform's way. */
export const FIELD_CHORDS = {
  submit: "CmdOrCtrl+Enter",
  newLine: "Shift+Enter",
  previousMatch: "Shift+Enter",
  matchCase: "Alt+C",
  regex: "Alt+R",
  folderUp: "CmdOrCtrl+Up",
  nextHost: "Ctrl+Tab",
  undo: "CmdOrCtrl+Z",
} as const;
