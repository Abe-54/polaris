/**
 * Settings' commands (`features/settings/actions.ts`): "Settings…", one per section for the K
 * menu, and the actions those sections hold (updates, GitHub accounts); part of KEYMAP.
 */
import type { KeyBinding, PaletteEntry } from "./keymap.ts";

export type SettingsCommandId =
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
  | "settings.voice"
  | "settings.attachments"
  | "github.addAccount";

const SETTINGS = (keywords: ReadonlyArray<string>): PaletteEntry => ({ group: "app", keywords });

export const SETTINGS_BINDINGS: ReadonlyArray<KeyBinding> = [
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
    id: "settings.voice",
    title: "Settings: Voice",
    keys: [],
    palette: SETTINGS([
      "dictation",
      "transcription",
      "microphone",
      "speech",
      "deepgram",
      "api key",
    ]),
  },
  {
    id: "settings.attachments",
    title: "Settings: Attachments",
    keys: [],
    palette: SETTINGS(["images", "files", "staged", "cleanup", "clear", "storage"]),
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
];
