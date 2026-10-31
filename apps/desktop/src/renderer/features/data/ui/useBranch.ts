/** The shown session's checkout branch, for the sidebar header and the status bar. */
import { useApp } from "../../../shell/hooks.ts";
import type { DataSessionKey } from "../model/store.ts";

export const useBranch = (at: DataSessionKey): string | null =>
  useApp((s) => {
    const model = s.hostModels[at.hostKey];
    const worktree = model?.sessions.get(at.sessionId)?.session.worktreeId;

    if (worktree === undefined || worktree === null) return null;

    return model?.worktrees.get(worktree)?.branch ?? null;
  });
