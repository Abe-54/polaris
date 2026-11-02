/**
 * "Clone on…" (Paper R5, not on any host): clones the pull request's repository into
 * `~/code/<name>` on the Host the user picks, with that Host's git credentials, in a terminal
 * whose output shows in its drawer; once git exits cleanly the folder becomes a Workspace, the
 * PR list matches it, and the pull request is checked out there.
 */
import { WorkspaceId } from "@polaris/protocol";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { OpenPull } from "../../../../shared/api.ts";
import { Commands } from "../../../commands.ts";
import { polaris } from "../../bridge.ts";
import { send } from "../../session/dispatch.ts";
import { runInTerminal } from "../../terminal/actions.ts";
import { followExit } from "./exit.ts";
import { remotesOnHost } from "../../pulls/ui/Publisher.tsx";
import { cloneCommand, clonePath, cloneTransport, cloneUrls } from "./model/clone.ts";
import { loginShellArgv } from "./model/run.ts";
import { rememberHost, repoName } from "./store.ts";

export interface CloneTarget {
  readonly hostKey: string;
  readonly label: string;
  readonly homeDir: string;
}

export interface CloneState {
  readonly hostKey: string;
  readonly host: string;
  readonly path: string;
  readonly status: "cloning" | "failed" | "added";
  readonly message: string | null;
}

/** Repository (`owner/name`, lowercased) → its clone in this window. */
const clones = createStore<Readonly<Record<string, CloneState>>>(() => ({}));

export const useClone = (pull: OpenPull): CloneState | null =>
  useStore(clones, (s) => s[repoName(pull.repo)] ?? null);

/** The drawer a clone's terminal lives in: the Host has no Workspace for it yet. */
const CLONE_DRAWER = WorkspaceId.make("review-clone");

const setClone = (repo: string, state: CloneState) => clones.setState({ [repo]: state });

const exists = async (hostKey: string, path: string) =>
  (await polaris().request("files.stat", { hostKey, path })).ok;

/** The first of `~/code/<name>`, `~/code/<name>-2`… that isn't taken. */
const freePath = async (target: CloneTarget, name: string) => {
  for (let n = 1; n <= 9; n++) {
    const path = clonePath(target.homeDir, name, n);

    if (!(await exists(target.hostKey, path))) return path;
  }

  return clonePath(target.homeDir, name, 10);
};

/** Once git exits: the folder becomes a Workspace, or the chip says what failed. */
const finished = (
  repo: string,
  target: CloneTarget,
  path: string,
  name: string,
  code: number | null
) => {
  if (code === 0) {
    setClone(repo, {
      hostKey: target.hostKey,
      host: target.label,
      path,
      status: "added",
      message: null,
    });
    void send(
      target.hostKey,
      Commands.RegisterWorkspace({ path, name }),
      "Couldn’t add the cloned folder as a workspace"
    );

    return;
  }

  setClone(repo, {
    hostKey: target.hostKey,
    host: target.label,
    path,
    status: "failed",
    message: `git clone exited with code ${code ?? "?"}; its output is in the terminal`,
  });
};

export const cloneOn = async (target: CloneTarget, pull: OpenPull, codeHost: string) => {
  const repo = repoName(pull.repo);
  const { owner, name } = pull.repo;
  const path = await freePath(target, name);
  const tabKey = `review-clone:${repo}`;
  const transport = cloneTransport(remotesOnHost(target.hostKey), codeHost);
  const urls = cloneUrls(codeHost, owner, name, transport);

  rememberHost(repo, target.hostKey);
  setClone(repo, {
    hostKey: target.hostKey,
    host: target.label,
    path,
    status: "cloning",
    message: null,
  });

  const terminal = await runInTerminal(
    { hostKey: target.hostKey, workspaceId: CLONE_DRAWER },
    {
      key: tabKey,
      title: `clone ${owner}/${name}`,
      cwd: target.homeDir,
      argv: loginShellArgv(cloneCommand(urls, path)),
    }
  );

  if (terminal !== null) {
    followExit(target.hostKey, terminal, (code) => finished(repo, target, path, name, code));

    return;
  }

  setClone(repo, {
    hostKey: target.hostKey,
    host: target.label,
    path,
    status: "failed",
    message: "Couldn’t open a terminal on the host",
  });
};

/** Forgets a finished clone once its Workspace holds the repository. */
export const forgetClone = (pull: OpenPull) =>
  clones.setState((s) => {
    const repo = repoName(pull.repo);

    if (s[repo] === undefined) return s;
    const { [repo]: _, ...rest } = s;

    return rest;
  });
