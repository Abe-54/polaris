/**
 * What setup reads beside the snapshot: the shown agent session, its Workspace's name, and (on
 * Daemons with `traces.settings`) the detected fixed exporters and forwarding; plus the deep link.
 */
import type {
  AgentSession,
  DetectedTraceExporter,
  SessionPlacement,
  WorkspaceId,
} from "@polaris/protocol";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { workspaceKeyOf } from "../../../../../shared/acceptBranch.ts";
import { useApp, useShellActions } from "../../../../shell/hooks.ts";
import { placementOf } from "../../model/agentSetup.ts";
import type { TracesSessionKey } from "../../model/session.ts";
import { tracesSettingsTarget } from "../../settings/focus.ts";
import { useWorkspaceTracesSettings } from "../../settings/hooks.tsx";
import { fixedExporters, tracesSettingsUnavailable } from "../../settings/model.ts";

/** Workspaces whose fixed-exporter card was put off with "Not now", until Polaris restarts. */
export const dismissedFixedCards = createStore<ReadonlySet<string>>(() => new Set());

export interface SetupPlaceView {
  readonly hostKey: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly session: AgentSession | null;
  /** Where a new agent session works; null until the session's feed arrives. */
  readonly placement: SessionPlacement | null;
  /** Empty without `traces.settings`, before detection answers, or once put off. */
  readonly fixed: ReadonlyArray<DetectedTraceExporter>;
  /** The collector Polaris forwards to, when forwarding is on and one is set. */
  readonly forwardingTo: string | null;
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
  const putOff = useStore(dismissedFixedCards, (s) => s.has(key));

  const { settings } = useWorkspaceTracesSettings(
    available ? { hostKey: at.hostKey, workspaceId: id } : null
  );

  const ready = settings.status === "ready" ? settings.value : null;

  return {
    hostKey: at.hostKey,
    workspaceId,
    workspaceName,
    session,
    placement:
      session === null ? null : placementOf(session, model?.reviewCheckouts.values() ?? []),
    fixed: ready === null || putOff ? [] : fixedExporters(ready),
    forwardingTo: ready?.forwarding === true ? (ready.forwardTo?.url ?? null) : null,
    openSettings: available
      ? () => {
          tracesSettingsTarget.setState({ hostKey: at.hostKey, workspaceId }, true);
          openSettings("traces");
        }
      : null,
    dismiss: () => dismissedFixedCards.setState((s) => new Set([...s, key]), true),
  };
};
