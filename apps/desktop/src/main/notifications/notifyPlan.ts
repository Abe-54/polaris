/**
 * Which agent notifications (MCP `notify`) to show: a session's latest, once per id, never for
 * the session the focused window shows, and none from before this app saw its first summary.
 */
import type {
  NeedsYouAction,
  NeedsYouNotification,
  NeedsYouSummary,
} from "../../shared/needsYou.ts";
import { notificationKey } from "./plan.ts";

/** Owner decision: agent banners always show, with no setting of their own. */
export const agentBannersOn = () => true;

/** Whether a notification shows: Polaris's own (`automatic`) follow their setting (ENG-462). */
export const bannerOn = (
  notification: Pick<NeedsYouNotification, "automatic">,
  constellationsOn: boolean
) => (notification.automatic === true ? constellationsOn : agentBannersOn());

/** What a click on the banner opens: the Constellation view when it is about one (ENG-473). */
export const clickAction = ({
  hostKey,
  sessionId,
  constellationId,
}: NeedsYouNotification): NeedsYouAction =>
  (constellationId ?? null) === null
    ? { action: "open", hostKey, sessionId }
    : { action: "open-constellation", hostKey, sessionId };

export interface NotifyState {
  /** Session key → the last notification id seen; null until the first summary (history). */
  readonly seen: ReadonlyMap<string, string> | null;
}

export const emptyNotifyState: NotifyState = { seen: null };

export interface AgentNotification {
  readonly key: string;
  readonly notification: NeedsYouNotification;
  readonly title: string;
  readonly subtitle: string;
  readonly body: string;
}

export interface NotifyPlan {
  readonly show: ReadonlyArray<AgentNotification>;
  /** New notifications for the session the focused window shows: no banner, you were there. */
  readonly held: ReadonlyArray<NeedsYouNotification>;
  readonly state: NotifyState;
}

/** Its own key space, so a Needs You or Turn banner for the same session never replaces it. */
export const agentKey = (hostKey: string, sessionId: string) =>
  `agent\u0000${notificationKey(hostKey, sessionId)}`;

export const planAgentNotifications = ({
  state,
  summary,
  windowFocused,
}: {
  readonly state: NotifyState;
  readonly summary: NeedsYouSummary;
  readonly windowFocused: boolean;
}): NotifyPlan => {
  const all = summary.notifications ?? [];
  const seen = new Map(state.seen ?? []);
  const isNew = (n: NeedsYouNotification) => seen.get(agentKey(n.hostKey, n.sessionId)) !== n.id;

  const fresh = state.seen === null ? [] : all.filter(isNew);

  for (const n of all) seen.set(agentKey(n.hostKey, n.sessionId), n.id);

  const here = (n: NeedsYouNotification) =>
    windowFocused &&
    summary.focused?.hostKey === n.hostKey &&
    summary.focused.sessionId === n.sessionId;

  const shown = fresh.filter((n) => !here(n));

  return {
    show: shown.map((n) => ({
      key: agentKey(n.hostKey, n.sessionId),
      notification: n,
      title: n.title,
      subtitle: `${n.sessionTitle} · ${n.hostLabel}`,
      body: n.body,
    })),
    held: fresh.filter(here),
    state: { seen },
  };
};
