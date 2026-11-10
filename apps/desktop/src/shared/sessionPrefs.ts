/** Settings → Sessions' defaults, shared by main (the settings file) and the renderer. */
import type { SessionPrefs } from "./api.ts";

/** A branch prefix git accepts: empty, or no spaces, `..`, `~^:?*[\\` or `@{`, not starting with "-" or "/". */
export const BRANCH_PREFIX = /^(?![-/])(?!.*\.\.)(?!.*@\{)[^\s~^:?*[\\]{0,64}$/;

export const isBranchPrefix = (prefix: string) => BRANCH_PREFIX.test(prefix);

export const DEFAULT_SESSION_PREFS: SessionPrefs = {
  newWorktree: false,
  branchPrefix: "polaris/",
  openOutputOnEdit: true,
  notifyNeedsYou: true,
  notifyTurnEnded: false,
  notifyLongTurnsOnly: false,
  longTurnMinutes: 5,
  notifyReviewRequests: true,
  notifyConstellations: true,
  quietPhoneWhilePresent: true,
  deleteMergedBranch: false,
  spinnerVerbs: null,
  acceptBranch: "auto",
  workspaceAcceptBranch: {},
  // Spec §4: backend on Codex · GPT-6.1-Sol · high, UI and design on Claude Code · Opus 5.5.
  constellationDefaults: {
    backend: { harness: "codex", model: "gpt-6.1-sol", effort: "high" },
    ui: { harness: "claude", model: "claude-opus-5-5", effort: null },
  },
  idleCompaction: { enabled: true, minTokens: 200_000 },
  suggestedReplies: { enabled: false, fallback: null },
  visuals: "rich",
  editorVim: false,
  editorAutosave: false,
  editorInlineDiagnostics: true,
  advancedView: false,
  developerMode: false,
  commitMessages: { harness: "claude", model: "claude-haiku-5-5", effort: null },
};

const COMMIT_MESSAGE_MODELS = new Map([
  ["claude", "claude-haiku-5-5"],
  ["codex", "gpt-6-luna"],
]);

/** A Harness's small, fast Model for commit messages, chosen when the Harness changes. */
export const commitMessageModel = (harness: string): string | null =>
  COMMIT_MESSAGE_MODELS.get(harness) ?? null;
