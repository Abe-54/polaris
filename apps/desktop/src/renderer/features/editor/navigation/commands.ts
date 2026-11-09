/**
 * The editor's language commands (DESIGN.md, Editor: Language assistance): every feature the
 * old tools row offered, as Command Palette commands, several with VS Code's keys.
 */
import { cmShortcut } from "../cm/keys.ts";
import type { LanguageCommand } from "../lsp/queries.ts";

export type NavigationAction =
  | LanguageCommand
  | "back"
  | "completion"
  | "forward"
  | "hover"
  | "next-problem"
  | "previous-problem"
  | "rename-field"
  | "signature-help"
  | "symbol-search";

export interface LanguageNavigationCommand {
  /** Namespaced for the palette's `contribute` ("editor.language.definition"). */
  readonly id: string;
  readonly title: string;
  readonly action: NavigationAction;
  /** CodeMirror key syntax; bound while the code has focus. */
  readonly key?: string;
  /** Its own extension binds `key` (completion, signature help); listed for the palette and menus. */
  readonly ownKeymap?: boolean;
  /** It works without a language server (completion falls back to the file's words). */
  readonly anyFile?: boolean;
  /** It asks for more (a name, a query) before it acts. */
  readonly followUp?: boolean;
  /** Vim normal-mode keys that run it through the command registry (`cm/vim.ts`). */
  readonly vim?: readonly string[];
}

export const LANGUAGE_NAVIGATION: readonly LanguageNavigationCommand[] = [
  {
    id: "editor.language.definition",
    title: "Go to definition",
    action: "definition",
    key: "F12",
    vim: ["gd"],
  },
  {
    id: "editor.language.declaration",
    title: "Go to declaration",
    action: "declaration",
    vim: ["gD"],
  },
  {
    id: "editor.language.typeDefinition",
    title: "Go to type definition",
    action: "typeDefinition",
    vim: ["gy"],
  },
  {
    id: "editor.language.implementation",
    title: "Go to implementation",
    action: "implementation",
    vim: ["gi"],
  },
  {
    id: "editor.language.references",
    title: "Find references",
    action: "references",
    key: "Shift-F12",
    vim: ["gr"],
  },
  { id: "editor.language.hover", title: "Show hover", action: "hover", vim: ["K"] },
  {
    id: "editor.language.symbols",
    title: "Go to symbol in file",
    action: "symbols",
    key: "Mod-Shift-o",
  },
  {
    id: "editor.language.workspaceSymbols",
    title: "Go to symbol in workspace…",
    action: "symbol-search",
    key: "Mod-t",
    followUp: true,
  },
  {
    id: "editor.language.rename",
    title: "Rename symbol…",
    action: "rename-field",
    key: "F2",
    followUp: true,
  },
  {
    id: "editor.language.problems",
    title: "Show problems",
    action: "problems",
    key: "Mod-Shift-m",
  },
  // ⌘. stays "Stop the turn", so code actions have no key.
  { id: "editor.language.actions", title: "Show code actions", action: "actions" },
  {
    id: "editor.language.completion",
    title: "Show completions",
    action: "completion",
    key: "Ctrl-Space",
    ownKeymap: true,
    anyFile: true,
  },
  {
    id: "editor.language.signature",
    title: "Show signature help",
    action: "signature-help",
    key: "Ctrl-Shift-Space",
    ownKeymap: true,
  },
  {
    id: "editor.language.nextProblem",
    title: "Go to next problem",
    action: "next-problem",
    key: "F8",
    vim: ["]d"],
  },
  {
    id: "editor.language.previousProblem",
    title: "Go to previous problem",
    action: "previous-problem",
    key: "Shift-F8",
    vim: ["[d"],
  },
  {
    id: "editor.language.back",
    title: "Go back",
    action: "back",
    anyFile: true,
    key: "Ctrl--",
    vim: ["<C-o>"],
  },
  {
    id: "editor.language.forward",
    title: "Go forward",
    action: "forward",
    anyFile: true,
    key: "Ctrl-Shift--",
    vim: ["<C-i>"],
  },
];

/** The command's key as the palette and menus show it ("⌃Space"), or "". */
export const shortcutOf = (command: LanguageNavigationCommand): string =>
  command.key === undefined ? "" : cmShortcut(command.key);
