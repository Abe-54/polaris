/**
 * Which Workspace holds Polaris's own code: one whose remote is Polaris's repository, or a fork
 * or clone that has Polaris's first commit. Reads only.
 */
import type { Workspace, WorkspaceId } from "@polaris/protocol";
import { runGitRaw } from "../git/git.ts";
import { listRemotes, parseRemoteUrl } from "../git/review/remotes.ts";

/** Polaris's repository, under its current and former owner. */
const POLARIS_REPOSITORIES = new Set(["luxdotdev/polaris", "lucasdoell/polaris"]);

/** The root commit of Polaris's history, which every fork shares. */
export const POLARIS_ROOT_COMMIT = "c4f54c5513d3f661435d4f8832ce73450d630c96";

/** Whether `url` names Polaris's repository on GitHub, in any transport. */
export const isPolarisRemote = (url: string): boolean => {
  const parsed = parseRemoteUrl(url);

  return (
    parsed !== null &&
    parsed.host === "github.com" &&
    POLARIS_REPOSITORIES.has(`${parsed.owner}/${parsed.name}`.toLowerCase())
  );
};

/** Whether the git repository at `path` is Polaris: by a remote, else by its root commit. */
export const isPolarisCheckout = async (path: string): Promise<boolean> => {
  const remotes = await listRemotes(path);

  if (remotes.some((remote) => isPolarisRemote(remote.url))) return true;

  const root = await runGitRaw(path, ["cat-file", "-e", `${POLARIS_ROOT_COMMIT}^{commit}`]);

  return root.code === 0;
};

/** The first registered git Workspace that is Polaris, visible ones first; null when none is. */
export const detectPolarisWorkspace = async (
  workspaces: ReadonlyArray<Workspace>,
  isPolaris: (path: string) => Promise<boolean> = isPolarisCheckout
): Promise<WorkspaceId | null> => {
  const ordered = workspaces
    .filter((workspace) => workspace.isGitRepo)
    .toSorted(
      (a, b) => Number(a.hidden) - Number(b.hidden) || a.registeredAt.localeCompare(b.registeredAt)
    );

  for (const workspace of ordered) {
    if (await isPolaris(workspace.path).catch(() => false)) return workspace.id;
  }

  return null;
};
