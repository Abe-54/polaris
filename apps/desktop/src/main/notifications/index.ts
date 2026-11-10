/**
 * Needs You outside the window: native notifications, the menu bar star and the app's badge,
 * fed by the renderer's summary (`needsYou.publish`). Answers go back to the renderer as app
 * events, which dispatches them like any other, so every answer from this device is one path.
 */
import { app, type BrowserWindow, nativeTheme, Notification } from "electron";
import type { AppEvent } from "../../shared/api.ts";
import type {
  NeedsYouAction,
  NeedsYouNotification,
  NeedsYouSummary,
} from "../../shared/needsYou.ts";
import { createStarTray, type StarTray } from "../tray/index.ts";
import {
  NOTIFICATION_BUTTONS,
  type NotificationHandlers,
  notificationHandlers,
  turnClick,
} from "./actions.ts";
import { showBadge } from "./badge.ts";
import { focusWindow } from "./focus.ts";
import { emptyTurnState, planTurnNotifications, type TurnNotification } from "./turnPlan.ts";
import {
  type AgentNotification,
  bannerOn,
  clickAction,
  emptyNotifyState,
  planAgentNotifications,
} from "./notifyPlan.ts";
import {
  emptyNotificationState,
  type NotificationContent,
  notificationKey,
  planNotifications,
} from "./plan.ts";

export interface NeedsYouCenterInput {
  readonly window: () => BrowserWindow | null;
  readonly send: (event: AppEvent) => void;
  /** Asked before each banner: off when hidden (tests) or switched off in Settings → Sessions. */
  readonly notify: () => boolean;
  /** The same for Turn-ended banners, which are off by default; never shown without it. */
  readonly notifyTurns?: () => boolean;
  /** Only Turns longer than this many minutes notify; null for every Turn. */
  readonly turnMinutes?: () => number | null;
  /** For agents' own notifications (MCP `notify`): off only when hidden; see `agentBannersOn`. */
  readonly notifyAgents?: () => boolean;
  /** For Polaris's own when a Constellation needs you; switched off in Settings → Sessions. */
  readonly notifyConstellations?: () => boolean;
}

export interface NeedsYouCenter {
  readonly publish: (summary: NeedsYouSummary) => void;
  readonly dispose: () => void;
}

/** What the smoke test reads from the main process. */
export interface NeedsYouProbe {
  readonly count: () => number;
  readonly trayTitle: () => string;
  /** Every pending request id in the summary. */
  readonly requests: () => ReadonlyArray<string>;
  /** Notifications planned so far (shown, or counted when `notify` is off). */
  readonly notified: () => number;
  /** The notifications standing now (shown, or only planned when `notify` is off). */
  readonly standing: () => ReadonlyArray<StandingNotification>;
  /** Presses a standing notification's button (0 Approve, 1 Deny) through its own handler. */
  readonly press: (key: string, index: number) => boolean;
  /** Sends a standing notification's inline reply through its own handler. */
  readonly reply: (key: string, text: string) => boolean;
  /** Turn-ended notifications planned so far, and whether each was shown on screen. */
  readonly turns: () => ReadonlyArray<{ readonly key: string; readonly shown: boolean }>;
  /** Agent notifications planned so far, and whether each was shown on screen. */
  readonly agents: () => ReadonlyArray<{ readonly id: string; readonly shown: boolean }>;
}

export interface StandingNotification {
  readonly key: string;
  readonly requestId: string;
  readonly actions: boolean;
  readonly reply: boolean;
}

declare global {
  var __polarisNeedsYou: NeedsYouProbe | undefined;
}

export const createNeedsYouCenter = ({
  window,
  send,
  notify,
  notifyTurns = () => false,
  turnMinutes = () => null,
  notifyAgents = () => true,
  notifyConstellations = () => true,
}: NeedsYouCenterInput): NeedsYouCenter => {
  let state = emptyNotificationState;
  let turnState = emptyTurnState;
  let agentState = emptyNotifyState;
  const agentsPlanned: Array<{ id: string; shown: boolean }> = [];
  let summary: NeedsYouSummary = { count: 0, sessions: [], focused: null, turns: [] };
  let planned = 0;
  const turnsPlanned: Array<{ key: string; shown: boolean }> = [];
  const live = new Map<string, Notification>();
  const standing = new Map<string, { content: NotificationContent; on: NotificationHandlers }>();

  const focus = () => focusWindow(window());

  const act = (action: NeedsYouAction) => {
    if (action.action === "open" || action.action === "open-constellation") focus();
    send({ kind: "needs-you", ...action });
  };

  const open = (hostKey: string, sessionId: string) => act({ action: "open", hostKey, sessionId });

  const tray: StarTray = createStarTray({
    onOpenSession: (session) => open(session.hostKey, session.sessionId),
    onOpenApp: focus,
    onQuit: () => app.quit(),
  });

  const close = (key: string) => {
    live.get(key)?.close();
    live.delete(key);
    standing.delete(key);
  };

  const show = (content: NotificationContent) => {
    planned++;
    close(content.key);
    const on = notificationHandlers(content, act);

    standing.set(content.key, { content, on });

    if (!notify() || !Notification.isSupported()) return;

    const notification = new Notification({
      title: content.title,
      subtitle: content.subtitle,
      body: content.body,
      actions: content.actions
        ? NOTIFICATION_BUTTONS.map((text) => ({ type: "button" as const, text }))
        : [],
      hasReply: content.reply,
      replyPlaceholder: "Answer",
    });

    notification.on("click", on.click);
    notification.on("action", (_event, index) => on.action(index));
    notification.on("reply", (_event, text) => on.reply(text));
    notification.on("close", () => {
      if (live.get(content.key) !== notification) return;
      live.delete(content.key);
      standing.delete(content.key);
    });
    live.set(content.key, notification);
    notification.show();
  };

  const showTurn = (content: TurnNotification) => {
    close(content.key);
    const shown = notifyTurns() && Notification.isSupported();

    turnsPlanned.push({ key: content.key, shown });

    if (!shown) return;

    const notification = new Notification({
      title: content.title,
      subtitle: content.subtitle,
      body: content.body,
    });

    notification.on("click", () => {
      focus();
      send(turnClick(content.turn));
    });
    notification.on("close", () => {
      if (live.get(content.key) === notification) live.delete(content.key);
    });
    live.set(content.key, notification);
    notification.show();
  };

  let recheck: ReturnType<typeof setTimeout> | null = null;

  /** Plans Turn-ended banners; a settle still waiting out `SETTLE_MS` plans again when it can count. */
  const planTurns = (windowFocused: boolean) => {
    const minutes = turnMinutes();

    const turns = planTurnNotifications({
      state: turnState,
      summary,
      windowFocused,
      minDurationMs: minutes === null ? null : minutes * 60_000,
      now: Date.now(),
    });

    turnState = turns.state;

    if (recheck !== null) clearTimeout(recheck);
    recheck = turns.recheckInMs === null ? null : setTimeout(replanTurns, turns.recheckInMs);

    return turns;
  };

  function replanTurns() {
    recheck = null;
    const turns = planTurns(window()?.isFocused() ?? false);

    for (const key of turns.close) close(key);

    for (const content of turns.show) showTurn(content);
  }

  /** The Desktop App's record of each agent banner, for the `notify` row (`agent-banner`). */
  const record = (n: NeedsYouNotification, banner: "shown" | "here" | "off") =>
    send({
      kind: "agent-banner",
      hostKey: n.hostKey,
      sessionId: n.sessionId,
      id: n.id,
      title: n.title,
      body: n.body,
      banner,
    });

  const showAgent = (content: AgentNotification) => {
    close(content.key);

    const shown =
      notifyAgents() &&
      bannerOn(content.notification, notifyConstellations()) &&
      Notification.isSupported();

    agentsPlanned.push({ id: content.notification.id, shown });
    record(content.notification, shown ? "shown" : "off");

    if (!shown) return;

    const notification = new Notification({
      title: content.title,
      subtitle: content.subtitle,
      body: content.body,
    });

    notification.on("click", () => act(clickAction(content.notification)));
    notification.on("close", () => {
      if (live.get(content.key) === notification) live.delete(content.key);
    });
    live.set(content.key, notification);
    notification.show();
  };

  const publish = (next: NeedsYouSummary) => {
    summary = next;
    const windowFocused = window()?.isFocused() ?? false;
    const plan = planNotifications({ state, summary, windowFocused });
    const turns = planTurns(windowFocused);
    const agents = planAgentNotifications({ state: agentState, summary, windowFocused });

    state = plan.state;
    agentState = agents.state;

    for (const key of [...plan.close, ...turns.close]) close(key);

    for (const content of plan.show) show(content);

    for (const content of turns.show) showTurn(content);

    for (const content of agents.show) showAgent(content);

    for (const n of agents.held) record(n, "here");
    tray.update(summary);
    showBadge(window(), summary.count);
  };

  // The taskbar's light or dark mode recolours Windows' badge.
  const rebadge = () => showBadge(window(), summary.count);

  nativeTheme.on("updated", rebadge);

  globalThis.__polarisNeedsYou = {
    count: () => summary.count,
    trayTitle: tray.title,
    requests: () => summary.sessions.flatMap((s) => s.requests.map((r) => r.requestId)),
    notified: () => planned,
    standing: () =>
      [...standing.values()].map(({ content }) => ({
        key: content.key,
        requestId: content.request.requestId,
        actions: content.actions,
        reply: content.reply,
      })),
    press: (key, index) => {
      const entry = standing.get(key);

      if (entry === undefined || !entry.content.actions) return false;
      entry.on.action(index);

      return true;
    },
    reply: (key, text) => {
      const entry = standing.get(key);

      if (entry === undefined || !entry.content.reply) return false;
      entry.on.reply(text);

      return true;
    },
    turns: () => [...turnsPlanned],
    agents: () => [...agentsPlanned],
  };

  return {
    publish,
    dispose: () => {
      if (recheck !== null) clearTimeout(recheck);

      for (const key of live.keys()) close(key);
      tray.destroy();
      nativeTheme.off("updated", rebadge);
      globalThis.__polarisNeedsYou = undefined;
    },
  };
};

export { notificationKey };
