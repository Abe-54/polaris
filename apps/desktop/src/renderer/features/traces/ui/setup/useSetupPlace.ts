/**
 * What setup reads beside the snapshot: the shown agent session, its Workspace's name, and (on
 * Daemons with `traces.settings`) the detected fixed exporters and forwarding; plus the deep link.
 */
import type { AgentSession, DetectedTraceExporter, WorkspaceId } from "@polaris/protocol";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { workspaceKeyOf } from "../../../../../shared/acceptBranch.ts";
import { useApp, useShellActions } from "../../../../shell/hooks.ts";
import type { TracesSessionKey } from "../../model/session.ts";
import { tracesSettingsTarget } from "../../settings/focus.ts";
import { useWorkspaceTracesSettings } from "../../settings/hooks.tsx";
import { fixedExporters, tracesSettingsUnavailable } from "../../settings/model.ts";

/** Workspaces whose fixed-exporter card was put off with "Not now", until Polaris restarts. */
const dismissed = createStore<ReadonlySet<string>>(() => new Set());

export interface SetupPlaceView {
  readonly hostKey: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly session: AgentSession | null;
  /** Empty without `traces.settings`, before detection answers, or once put off. */
  readonly fixed: ReadonlyArray<DetectedTraceExporter>;
  readonly forwarding: boolean;
  /** Settings → Traces for this Workspace; null when its Host can't show them. */
  readonly openSettings: (() => void) | null;
  readonly dismiss: () => void;
}

export const useSetupPlace = (at: TracesSessionKey, workspaceId: string): SetupPlaceView => {
  const { openSettings } = useShellActions();
  const host = useApp((s) => s.hosts.find((h) => h.key === at.hostKey));
  const model = useApp((s) => s.hostModels[at.hostKey]);
  const session = model?.sessions.get(at.sessionId)?.session ?? null;
  // SAFETY: the selection's Workspace id comes from the Host's own Workspace list.
  const id = workspaceId as WorkspaceId;
  const workspaceName = model?.workspaces.get(id)?.name ?? "This workspace";
  const available = tracesSettingsUnavailable(host) === null;
  const key = workspaceKeyOf(at.hostKey, workspaceId);
  const putOff = useStore(dismissed, (s) => s.has(key));

  const { settings } = useWorkspaceTracesSettings(
    available ? { hostKey: at.hostKey, workspaceId: id } : null
  );

  const ready = settings.status === "ready" ? settings.value : null;

  return {
    hostKey: at.hostKey,
    workspaceId,
    workspaceName,
    session,
    fixed: ready === null || putOff ? [] : fixedExporters(ready),
    forwarding: ready?.forwarding ?? false,
    openSettings: available
      ? () => {
          tracesSettingsTarget.setState({ hostKey: at.hostKey, workspaceId }, true);
          openSettings("traces");
        }
      : null,
    dismiss: () => dismissed.setState((s) => new Set([...s, key]), true),
  };
};
