/**
 * Every command in one table: the renderer's dispatcher runs their shortcuts,
 * the native menu shows them (without registering, so the renderer stays the
 * one handler), the help overlay and the Command Palette list them, and a test
 * checks for conflicts. Chords use Electron's accelerator syntax ("CmdOrCtrl+Shift+A").
 * Features add commands of their own at run time (`routes/commands.ts`, `contribute`).
 */
import { Predicate } from "effect";
import { acceleratorLabel, currentKeyPlatform, type KeyPlatform } from "./chord.ts";
import { DATA_BINDINGS, type DataCommandId } from "./keymapData.ts";
import { DIFF_BINDINGS, type DiffCommandId } from "./keymapDiff.ts";
import { VIEW_BINDINGS, type ViewCommandId } from "./keymapView.ts";

export type CommandId =
  | ViewCommandId
  | "jump.open"
  | "help.shortcuts"
  | "session.new"
  | "session.next"
  | "session.previous"
  | "navigation.back"
  | "navigation.forward"
  | "session.focusComposer"
  | "session.interrupt"
  | "session.background"
  | "approval.approve"
  | "approval.deny"
  | "session.archive"
  | "session.openInTerminal"
  | "transcript.find"
  | "transcript.jumpToEnd"
  | "theme.toggle"
  | "settings.open"
  | "settings.about"
  | "updates.check"
  | "updates.restart"
  | "settings.appearance"
  | "settings.sessions"
  | "settings.editor"
  | "settings.harnesses"
  | "settings.constellations"
  | "settings.usage"
  | "settings.hosts"
  | "settings.reviewer"
  | "settings.github"
  | "github.addAccount"
  | "workspace.add"
  | "review.nextTab"
  | "review.previousTab"
  | "editor.findFile"
  | "editor.findInWorkspace"
  | "editor.inlineChat"
  | "editor.addToSession"
  | DataCommandId
  | "editor.markdownPreview"
  | "git.writeMessage"
  | "editor.save"
  | "editor.nextTab"
  | "editor.previousTab"
  | DiffCommandId
  | "tab.close"
  | "tab.closeOthers"
  | "window.close"
  | "palette.open"
  | "editor.format"
  | "editor.toggleInlineDiagnostics"
  | "editor.prediction.accept"
  | "editor.prediction.acceptWord"
  | "editor.prediction.dismiss"
  | "editor.prediction.showLast"
  | "language.restart"
  | "language.restartAll"
  | "language.showLog"
  | "typescript.selectVersion"
  | "python.selectInterpreter"
  | "sql.selectDialect"
  | "trust.grant"
  | "trust.revoke"
  | "trust.askAgain";

export type MenuName = "App" | "File" | "View" | "Go" | "Session" | "Help";

/** The palette's groups (DESIGN.md, Command Palette): the focused file's, the Workspace's, the app's. */
export type CommandGroup = "file" | "workspace" | "app";

/** Facts about the moment that features put in the command context; `when` reads them. */
export const CONTEXT_KEYS = [
  /** The Edit view is showing. */
  "mode.edit",
  /** The Data view is showing. */
  "mode.data",
  /** A file is open and focused in Edit. */
  "editor.file",
  "prediction.ghost",
  /** The focused file's Language Integration has a language server. */
  "language.server",
  "language.formatter",
  "language.typescript",
  /** A Python file whose checkout the Daemon has named, so its interpreters can be listed. */
  "language.python",
  /** A SQL file whose checkout the Daemon has named, so its dialect can be read. */
  "language.sql",
  /** Something can open the language server log (`features/editor/intents/languageLog.ts`). */
  "language.log",
  "workspace",
  /** The Daemon has said how the focused file's checkout is trusted. */
  "trust.known",
  "trust.trusted",
  "trust.declined",
  "trust.undecided",
] as const;

export type ContextKey = (typeof CONTEXT_KEYS)[number];

const isContextKey = (condition: Condition): condition is ContextKey =>
  Predicate.isString(condition);

/** Words a title takes from the context: "Restart {language} server". */
export type ContextValue =
  | "language"
  | "file"
  | "workspace"
  /** Where Workspaces are listed: "top bar", or "sidebar" with the machine bar. */
  | "workspaceList"
  | "session"
  | "trustSubject"
  | "typescriptChoice"
  | "pythonInterpreter"
  | "sqlDialect"
  | "updateVersion";

export interface CommandContext {
  readonly keys: ReadonlySet<ContextKey>;
  readonly values: Readonly<Partial<Record<ContextValue, string>>>;
}

/** An availability condition over the context, like VS Code's when clauses. */
export type Condition =
  | ContextKey
  | { readonly not: Condition }
  | { readonly all: ReadonlyArray<Condition> }
  | { readonly any: ReadonlyArray<Condition> };

export const holds = (condition: Condition | undefined, keys: ReadonlySet<ContextKey>): boolean => {
  if (condition === undefined) return true;

  if (isContextKey(condition)) return keys.has(condition);

  if ("not" in condition) return !holds(condition.not, keys);

  if ("all" in condition) return condition.all.every((c) => holds(c, keys));

  return condition.any.some((c) => holds(c, keys));
};

/** A title template filled from the context; null when a word it needs is missing. */
export const fillTitle = (template: string, values: CommandContext["values"]): string | null => {
  let missing = false;

  const filled = template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = new Map(Object.entries(values)).get(name);

    if (value === undefined || value === "") missing = true;

    return value ?? "";
  });

  return missing ? null : filled;
};

export interface PaletteEntry {
  readonly group: CommandGroup;
  /** The palette's title template when it differs from the menu's ("New session in {workspace}"). */
  readonly title?: string;
  /** A caption after the title ("project 7.0.2 or bundled"). */
  readonly detail?: string;
  /** Other words it is found by. */
  readonly keywords?: ReadonlyArray<string>;
  /** It asks a follow-up in the palette; the binding needs input (rule/ellipsis-means-input). */
  readonly followUp?: boolean;
  /** Found only by searching, never listed on an empty query (easter eggs). */
  readonly searchOnly?: boolean;
}

export interface KeyBinding {
  readonly id: CommandId;
  readonly title: string;
  /** Accelerators; the first is the one menus and hints show. Empty: menu or jump menu only. */
  readonly keys: ReadonlyArray<string>;
  /** It asks for more (a dialog, picker or confirmation) before it runs; titles end in "…". */
  readonly needsInput?: boolean;
  /** Bare keys (no ⌘/⌃/⌥) never fire while typing in a field; chords do unless this is false. */
  readonly inFields?: boolean;
  /** Where the native menu lists it, if anywhere. */
  readonly menu?: MenuName;
  /** Another command on the same chord; the first enabled one runs, so they must not overlap. */
  readonly shares?: CommandId;
  /** When it can run at all; the handler's own `enabled` is checked too. */
  readonly when?: Condition;
  /** How the Command Palette lists it; false keeps it out. Default: the app group. */
  readonly palette?: PaletteEntry | false;
}

const APP: PaletteEntry = { group: "app" };

/** The palette entry of a binding: its own, or the app group's default. */
export const paletteEntry = (binding: KeyBinding): PaletteEntry | null =>
  binding.palette === false ? null : (binding.palette ?? APP);

const FILE = (entry: Omit<PaletteEntry, "group"> = {}): PaletteEntry => ({
  group: "file",
  ...entry,
});

const WORKSPACE = (entry: Omit<PaletteEntry, "group"> = {}): PaletteEntry => ({
  group: "workspace",
  ...entry,
});

const SETTINGS = (keywords: ReadonlyArray<string>): PaletteEntry => ({ group: "app", keywords });

/** The focused file's checkout, by how the Daemon trusts it. */
const TRUST_KNOWN: Condition = { all: ["editor.file", "trust.known"] };

export const KEYMAP: ReadonlyArray<KeyBinding> = [
  {
    id: "editor.prediction.accept",
    title: "Accept tab completion",
    keys: ["Tab"],
    when: { all: ["editor.file", "prediction.ghost"] },
    palette: false,
  },
  {
    id: "editor.prediction.acceptWord",
    title: "Accept a word of tab completion",
    keys: ["Alt+Right"],
    when: { all: ["editor.file", "prediction.ghost"] },
    palette: false,
  },
  {
    id: "editor.prediction.dismiss",
    title: "Dismiss tab completion",
    keys: ["Esc"],
    when: { all: ["editor.file", "prediction.ghost"] },
    palette: false,
    shares: "session.interrupt",
  },
  { id: "editor.prediction.showLast", title: "Show last edit prediction", keys: [] },
  {
    id: "palette.open",
    title: "Command Palette…",
    needsInput: true,
    keys: ["CmdOrCtrl+Shift+P"],
    menu: "View",
    palette: false,
  },
  // Language tooling (docs/specs/editor-language-tooling-v2.md §6).
  {
    id: "language.restart",
    title: "Restart language server",
    keys: ["CmdOrCtrl+Alt+R"],
    when: { all: ["editor.file", "language.server"] },
    palette: FILE({ title: "Restart {language} server", keywords: ["lsp", "reload"] }),
  },
  {
    id: "typescript.selectVersion",
    title: "Select TypeScript version…",
    needsInput: true,
    keys: [],
    when: { all: [TRUST_KNOWN, "language.typescript"] },
    palette: FILE({
      detail: "{typescriptChoice}",
      keywords: ["tsc", "project", "bundled", "tsserver"],
      followUp: true,
    }),
  },
  {
    id: "python.selectInterpreter",
    title: "Python: Select interpreter…",
    needsInput: true,
    keys: [],
    when: { all: ["editor.file", "language.python"] },
    palette: FILE({
      detail: "{pythonInterpreter}",
      keywords: ["venv", "uv", "python3", "environment", "basedpyright"],
      followUp: true,
    }),
  },
  {
    id: "sql.selectDialect",
    title: "SQL: Select dialect…",
    needsInput: true,
    keys: [],
    when: { all: ["editor.file", "language.sql"] },
    palette: FILE({
      detail: "{sqlDialect}",
      keywords: ["postgres", "postgresql", "mysql", "sqlite", "sqllens"],
      followUp: true,
    }),
  },
  {
    id: "editor.format",
    title: "Format document",
    keys: ["Shift+Alt+F"],
    when: { all: ["editor.file", "language.formatter"] },
    palette: FILE({ keywords: ["prettier", "ruff", "tidy"] }),
  },
  {
    id: "language.showLog",
    title: "Show language server log",
    keys: [],
    when: { all: ["editor.file", "language.server", "language.log"] },
    palette: FILE({ keywords: ["lsp", "output", "debug"] }),
  },
  {
    id: "language.restartAll",
    title: "Restart all language servers",
    keys: [],
    when: "workspace",
    palette: WORKSPACE({
      title: "Restart all language servers in {workspace}",
      keywords: ["lsp", "reload"],
    }),
  },
  {
    id: "trust.grant",
    title: "Trust workspace…",
    needsInput: true,
    keys: [],
    when: { all: [TRUST_KNOWN, { not: "trust.trusted" }] },
    palette: WORKSPACE({
      title: "Trust {trustSubject}…",
      keywords: ["typescript"],
      followUp: true,
    }),
  },
  {
    id: "trust.revoke",
    title: "Revoke trust",
    keys: [],
    when: { all: [TRUST_KNOWN, "trust.trusted"] },
    palette: WORKSPACE({ title: "Revoke trust in {trustSubject}", keywords: ["untrust"] }),
  },
  {
    id: "trust.askAgain",
    title: "Ask about trust again",
    keys: [],
    when: { all: [TRUST_KNOWN, "trust.declined"] },
    palette: WORKSPACE({ keywords: ["trust", "reset", "not now"] }),
  },
  // The views and how they draw (keymapView.ts).
  ...VIEW_BINDINGS,
  {
    id: "jump.open",
    title: "Jump to…",
    needsInput: true,
    keys: ["CmdOrCtrl+K", "K"],
    menu: "Go",
  },
  // Control+Tab on every platform; in Edit it cycles editor tabs instead (`shares`).
  {
    id: "session.next",
    title: "Next session",
    keys: ["CmdOrCtrl+Alt+Down", "Ctrl+Tab"],
    menu: "Go",
  },
  {
    id: "session.previous",
    title: "Previous session",
    keys: ["CmdOrCtrl+Alt+Up", "Ctrl+Shift+Tab"],
    menu: "Go",
  },
  // Also the mouse's back and forward buttons (routes/keyboard.ts).
  { id: "navigation.back", title: "Back", keys: ["CmdOrCtrl+["], menu: "Go" },
  { id: "navigation.forward", title: "Forward", keys: ["CmdOrCtrl+]"], menu: "Go" },
  {
    id: "session.new",
    title: "New session",
    keys: ["CmdOrCtrl+N"],
    menu: "Session",
    palette: WORKSPACE({
      title: "New session in {workspace}",
      keywords: ["create", "start", "agent"],
    }),
  },
  {
    id: "editor.findFile",
    title: "Go to file…",
    needsInput: true,
    keys: ["CmdOrCtrl+P"],
    menu: "Go",
    palette: WORKSPACE({ keywords: ["open", "file", "finder"] }),
  },
  {
    id: "editor.findInWorkspace",
    title: "Find in workspace…",
    needsInput: true,
    keys: ["CmdOrCtrl+Shift+F"],
    menu: "Go",
    palette: WORKSPACE({ title: "Find in {workspace}…", keywords: ["search", "grep"] }),
  },
  {
    id: "editor.inlineChat",
    title: "Edit or ask…",
    needsInput: true,
    keys: ["CmdOrCtrl+I"],
    palette: FILE({ keywords: ["inline", "chat", "agent"] }),
  },
  // Only with a selection in Edit; otherwise ⌘L focuses the composer.
  {
    id: "editor.addToSession",
    title: "Add to agent session",
    keys: ["CmdOrCtrl+L"],
    shares: "session.focusComposer",
    palette: FILE({ keywords: ["selection", "attach"] }),
  },
  {
    id: "session.focusComposer",
    title: "Focus the composer",
    keys: ["CmdOrCtrl+L"],
    menu: "Session",
    palette: WORKSPACE({ keywords: ["prompt", "message"] }),
  },
  ...DATA_BINDINGS,
  {
    id: "session.interrupt",
    title: "Stop the turn",
    keys: ["CmdOrCtrl+."],
    menu: "Session",
    palette: WORKSPACE({ keywords: ["interrupt", "cancel"] }),
  },
  { id: "session.background", title: "Run in background", keys: ["Ctrl+B"], menu: "Session" },
  {
    id: "approval.approve",
    title: "Approve",
    keys: ["CmdOrCtrl+Shift+A"],
    menu: "Session",
    palette: WORKSPACE({ keywords: ["allow", "approval"] }),
  },
  {
    id: "approval.deny",
    title: "Deny",
    keys: ["CmdOrCtrl+Shift+D"],
    menu: "Session",
    palette: WORKSPACE({ keywords: ["reject", "approval"] }),
  },
  {
    id: "session.openInTerminal",
    title: "Open in terminal",
    keys: [],
    menu: "Session",
    palette: WORKSPACE({ title: "Open {session} in terminal", keywords: ["tui", "handoff"] }),
  },
  {
    id: "transcript.find",
    title: "Find in transcript…",
    needsInput: true,
    keys: ["CmdOrCtrl+F"],
    menu: "Session",
    palette: WORKSPACE({ keywords: ["search", "chat", "conversation", "turn"] }),
  },
  // Outside fields only: in the composer ⌘↓ keeps moving the caret to the end.
  {
    id: "transcript.jumpToEnd",
    title: "Jump to latest",
    keys: ["CmdOrCtrl+Down"],
    inFields: false,
    menu: "Session",
    palette: WORKSPACE({ keywords: ["scroll", "bottom", "end", "conversation"] }),
  },
  {
    id: "session.archive",
    title: "Archive session",
    keys: [],
    menu: "Session",
    palette: WORKSPACE({ title: "Archive {session}", keywords: ["close", "hide"] }),
  },
  {
    id: "theme.toggle",
    title: "Toggle dark and light",
    keys: [],
    palette: SETTINGS(["appearance", "dark", "light", "theme"]),
  },
  { id: "review.nextTab", title: "Next review tab", keys: ["CmdOrCtrl+Shift+]"], menu: "Go" },
  {
    id: "review.previousTab",
    title: "Previous review tab",
    keys: ["CmdOrCtrl+Shift+["],
    menu: "Go",
  },
  {
    id: "workspace.add",
    title: "Add workspace…",
    needsInput: true,
    keys: ["CmdOrCtrl+O"],
    menu: "Go",
    palette: SETTINGS(["open", "folder", "repository"]),
  },
  // macOS's own Settings… chord, in the app menu (DESIGN.md, Settings).
  {
    id: "settings.open",
    title: "Settings…",
    needsInput: true,
    keys: ["CmdOrCtrl+,"],
    menu: "App",
    palette: SETTINGS(["preferences"]),
  },
  {
    id: "settings.about",
    title: "Settings: About",
    keys: [],
    palette: SETTINGS(["version", "release", "polaris"]),
  },
  {
    id: "updates.check",
    title: "Check for updates",
    keys: [],
    palette: SETTINGS(["update", "release", "version"]),
  },
  {
    id: "updates.restart",
    title: "Restart to update",
    keys: [],
    palette: {
      group: "app",
      detail: "Polaris {updateVersion} · agent sessions keep working",
      keywords: ["update", "restart", "upgrade"],
    },
  },
  {
    id: "settings.appearance",
    title: "Settings: Appearance",
    keys: [],
    palette: SETTINGS(["theme", "density", "text size", "font", "motion", "colourblind"]),
  },
  {
    id: "settings.sessions",
    title: "Settings: Sessions",
    keys: [],
    palette: SETTINGS(["worktree", "branch", "prefix", "output", "notifications", "archive"]),
  },
  {
    id: "settings.editor",
    title: "Settings: Editor",
    keys: [],
    palette: SETTINGS(["vim", "format on save", "languages", "autosave"]),
  },
  {
    id: "editor.toggleInlineDiagnostics",
    title: "Toggle inline diagnostics",
    keys: [],
    palette: SETTINGS(["error lens", "errors", "warnings", "problems", "diagnostics"]),
  },
  {
    id: "settings.harnesses",
    title: "Settings: Harnesses",
    keys: [],
    palette: SETTINGS(["claude", "codex", "opencode", "sign in", "model", "permissions"]),
  },
  {
    id: "settings.constellations",
    title: "Settings: Constellations",
    keys: [],
    palette: SETTINGS(["lead", "workers"]),
  },
  {
    id: "settings.usage",
    title: "Settings: Usage",
    keys: [],
    palette: SETTINGS(["tokens", "cost", "plan limits", "rate limit"]),
  },
  {
    id: "settings.hosts",
    title: "Settings: Hosts",
    keys: [],
    palette: SETTINGS(["machines", "ssh"]),
  },
  {
    id: "settings.reviewer",
    title: "Settings: Reviewer",
    keys: [],
    palette: SETTINGS(["review", "risk summary", "model", "effort", "codex", "claude"]),
  },
  {
    id: "settings.github",
    title: "Settings: GitHub accounts",
    keys: [],
    palette: SETTINGS(["github", "account", "owner", "organization", "sign in", "pull requests"]),
  },
  {
    id: "github.addAccount",
    title: "Add GitHub account…",
    needsInput: true,
    keys: [],
    palette: SETTINGS(["github", "sign in", "device code"]),
  },
  {
    id: "help.shortcuts",
    title: "Keyboard shortcuts",
    keys: ["CmdOrCtrl+/", "Shift+/"],
    menu: "Help",
    palette: SETTINGS(["help", "keys", "hotkeys"]),
  },
  // The Editor (spec §4): these keep working in every vim mode.
  {
    id: "editor.markdownPreview",
    title: "Open Markdown preview",
    keys: ["CmdOrCtrl+Shift+V"],
    menu: "View",
    palette: FILE({ keywords: ["render"] }),
  },
  { id: "editor.save", title: "Save file", keys: ["CmdOrCtrl+S"], palette: FILE() },
  {
    id: "git.writeMessage",
    title: "Write commit message",
    keys: ["CmdOrCtrl+Alt+G"],
    when: "mode.edit",
    palette: WORKSPACE({ keywords: ["git", "commit", "message", "generate"] }),
  },
  {
    id: "editor.nextTab",
    title: "Next editor tab",
    keys: ["Ctrl+Tab"],
    shares: "session.next",
    when: "mode.edit",
    palette: FILE(),
  },
  {
    id: "editor.previousTab",
    title: "Previous editor tab",
    keys: ["Ctrl+Shift+Tab"],
    shares: "session.previous",
    when: "mode.edit",
    palette: FILE(),
  },
  // Diff tabs (DESIGN.md, Editor: diff tabs).
  ...DIFF_BINDINGS,
  // With no tab open, Close tab closes the window, as in VS Code.
  { id: "tab.close", title: "Close tab", keys: ["CmdOrCtrl+W"], menu: "File", palette: FILE() },
  {
    id: "tab.closeOthers",
    title: "Close other tabs",
    keys: ["CmdOrCtrl+Alt+T"],
    menu: "File",
    palette: FILE(),
  },
  {
    id: "window.close",
    title: "Close window",
    keys: ["CmdOrCtrl+Shift+W"],
    menu: "File",
    palette: APP,
  },
];

/** The standard edit chords, which the native Edit menu owns; context menus show them. */
export const EDIT_CHORDS = {
  cut: "CmdOrCtrl+X",
  copy: "CmdOrCtrl+C",
  paste: "CmdOrCtrl+V",
  selectAll: "CmdOrCtrl+A",
} as const;

/** Chords macOS, Electron or the standard menus own; nothing here may take them. */
export const RESERVED: ReadonlyArray<string> = [
  "CmdOrCtrl+Q",
  "CmdOrCtrl+H",
  "CmdOrCtrl+Alt+H",
  "CmdOrCtrl+M",
  ...Object.values(EDIT_CHORDS),
  "CmdOrCtrl+Z",
  "CmdOrCtrl+Shift+Z",
  "CmdOrCtrl+`",
  "CmdOrCtrl+R",
  "CmdOrCtrl+Alt+I",
  "CmdOrCtrl+Shift+/",
  "CmdOrCtrl+Shift+3",
  "CmdOrCtrl+Shift+4",
  "CmdOrCtrl+Shift+5",
  "CmdOrCtrl+Ctrl+F",
  "CmdOrCtrl+Ctrl+Q",
  "CmdOrCtrl+Space",
  "Ctrl+Space",
  "CmdOrCtrl+Tab",
];

/**
 * Windows' and Linux desktops' own chords, the menu roles' accelerators there, Shift+F10
 * (context menus) and Ctrl+H (Replace, by convention). The Windows key never appears in a binding.
 */
export const PC_RESERVED: ReadonlyArray<string> = [
  "Alt+F4",
  "Alt+Space",
  "Alt+Tab",
  "Alt+Shift+Tab",
  "Alt+Esc",
  "Ctrl+Esc",
  "Ctrl+Shift+Esc",
  "Ctrl+Alt+Delete",
  "F10",
  "Shift+F10",
  "F11",
  ...Object.values(EDIT_CHORDS),
  "CmdOrCtrl+Z",
  "CmdOrCtrl+Y",
  "CmdOrCtrl+Shift+Z",
  "CmdOrCtrl+R",
  "CmdOrCtrl+Shift+I",
  "CmdOrCtrl+H",
  "CmdOrCtrl+Q",
  "Ctrl+Space",
];

/** The chords a platform keeps for itself. */
export const reservedFor = (platform: KeyPlatform): ReadonlyArray<string> =>
  platform === "mac" ? RESERVED : PC_RESERVED;

/**
 * Where Windows and Linux differ: Ctrl+Alt is AltGr on European layouts (it types @, {, €),
 * so those chords move; Ctrl picks Workspaces and sessions, Alt the views. Empty: menu and palette only.
 */
export const PC_KEYS: Partial<Record<CommandId, ReadonlyArray<string>>> = {
  "editor.prediction.acceptWord": ["Ctrl+Right"],
  "language.restart": ["CmdOrCtrl+Shift+R"],
  "view.orchestrate": ["Alt+1"],
  "view.review": ["Alt+2"],
  "view.edit": ["Alt+3"],
  "view.data": ["Alt+4"],
  "view.output": ["CmdOrCtrl+Shift+B"],
  "session.next": ["CmdOrCtrl+PageDown", "Ctrl+Tab"],
  "session.previous": ["CmdOrCtrl+PageUp", "Ctrl+Shift+Tab"],
  "tab.closeOthers": [],
  "git.writeMessage": ["CmdOrCtrl+Shift+G"],
};

/** The keymap with a platform's own keys. */
export const keymapFor = (platform: KeyPlatform): ReadonlyArray<KeyBinding> =>
  platform === "mac"
    ? KEYMAP
    : KEYMAP.map((b) => {
        const keys = PC_KEYS[b.id];

        return keys === undefined ? b : { ...b, keys };
      });

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

/** ⌃1…⌃0 and ⌥1…⌥0 pick Workspace chips or machines; they are data-driven, so outside KEYMAP. */
export const SHORTCUT_DIGIT_MODIFIERS: ReadonlyArray<string> = ["Ctrl", "Alt"];

/** On Windows and Linux only Ctrl+1…0, as browser tabs: Alt+1–3 are the views there. */
export const digitModifiersFor = (platform: KeyPlatform): ReadonlyArray<"Ctrl" | "Alt"> =>
  platform === "mac" ? ["Ctrl", "Alt"] : ["Ctrl"];

/** The chord of the chip at `index` ("Ctrl+1"; "Ctrl+0" is the tenth), in the platform's first modifier. */
export const digitChord = (index: number, platform: KeyPlatform): string | undefined => {
  if (index < 0 || index > 9) return undefined;

  return `${digitModifiersFor(platform)[0] ?? "Ctrl"}+${(index + 1) % 10}`;
};

export const bindingOf = (id: CommandId): KeyBinding | undefined => KEYMAP.find((b) => b.id === id);

/** The chord a menu shows for a command: its first accelerator on the platform, if it has one. */
export const chordOf = (id: CommandId, platform: KeyPlatform): string | undefined =>
  keymapFor(platform).find((b) => b.id === id)?.keys[0];

/** A command's shortcut as copy shows it ("⌘N", "Ctrl+N"), or "" when it has none there. */
export const commandShortcut = (
  id: CommandId,
  platform: KeyPlatform = currentKeyPlatform()
): string => acceleratorLabel(chordOf(id, platform), platform) ?? "";
