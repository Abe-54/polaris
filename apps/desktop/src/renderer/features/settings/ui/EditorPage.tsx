/**
 * Settings → Editor (DESIGN.md, Settings: Editor and Editor · languages): the
 * app wiring around `EditorSettings`, which holds the page itself.
 */
import type * as P from "@polaris/protocol";
import { useCallback, useMemo } from "react";
import { polaris } from "../../bridge.ts";
import { refreshLanguageSettings } from "../../editor/api.ts";
import { useApp, useConnection, useSelection } from "../../../shell/hooks.ts";
import type { HostModel } from "../../../store/hostModel.ts";
import { EditorSettings } from "../editor/EditorSettings.tsx";
import { CommitMessagesChoice } from "./CommitMessagesChoice.tsx";
import { setSessionPrefs, useSettings } from "../store.ts";
import { TabCompletion } from "../editor/TabCompletion.tsx";

const refreshPreviews = (hostKey: string, workspaceId: P.WorkspaceId) => {
  void import("../../editor/runtime/actions.ts").then((actions) =>
    actions.refreshMarkdownPolicy(hostKey, workspaceId)
  );
};

/** The selected Workspace when it's a repository, else the Host's first repository. */
const commitWorkspaceOf = (
  hostKey: string | null,
  workspaceId: P.WorkspaceId | null,
  models: Readonly<Record<string, HostModel>>
) => {
  const workspaces = hostKey === null ? undefined : models[hostKey]?.workspaces;

  if (hostKey === null || workspaces === undefined) return null;
  const selected = workspaceId === null ? undefined : workspaces.get(workspaceId);

  const repo =
    selected?.isGitRepo === true ? selected : [...workspaces.values()].find((w) => w.isGitRepo);

  return repo === undefined ? null : { hostKey, cwd: repo.path };
};

export const EditorPage = () => {
  const prefs = useSettings((s) => s.sessions);
  const hosts = useApp((s) => s.hosts);
  const connection = useConnection();
  const selection = useSelection();
  const models = useApp((s) => s.hostModels);

  const commitWorkspace = useMemo(
    () => commitWorkspaceOf(selection.hostKey, selection.workspaceId, models),
    [selection.hostKey, selection.workspaceId, models]
  );

  const workspacesOf = useCallback(
    (hostKey: string) =>
      [...(connection.store.getState().hostModels[hostKey]?.workspaces.values() ?? [])].map(
        (w) => ({ id: w.id, name: w.name })
      ),
    [connection]
  );

  const refreshEditors = useCallback(
    (hostKey: string | null) => {
      const models = connection.store.getState().hostModels;

      for (const [key, model] of Object.entries(models)) {
        if (hostKey !== null && key !== hostKey) continue;

        for (const workspaceId of model.workspaces.keys())
          refreshLanguageSettings(key, workspaceId);
      }
    },
    [connection]
  );

  return (
    <EditorSettings
      tabCompletion={<TabCompletion hosts={hosts} />}
      api={polaris().languages}
      hosts={hosts}
      workspacesOf={workspacesOf}
      keys={{
        vim: prefs.editorVim,
        autosave: prefs.editorAutosave,
        onVim: (on) => setSessionPrefs({ editorVim: on }),
        onAutosave: (on) => setSessionPrefs({ editorAutosave: on }),
        inlineDiagnostics: prefs.editorInlineDiagnostics,
        onInlineDiagnostics: (on) => setSessionPrefs({ editorInlineDiagnostics: on }),
        commitMessages: <CommitMessagesChoice />,
      }}
      refreshEditors={refreshEditors}
      refreshPreviews={refreshPreviews}
      commitWorkspace={commitWorkspace}
    />
  );
};
