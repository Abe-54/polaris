/** The inbox as the main process needs it: the count, who is waiting on what, and who is working. */
import { harnessHue } from "@polaris/ui";
import type { HostView } from "../../../../shared/api.ts";
import type {
  NeedsYouNotification,
  NeedsYouSession,
  NeedsYouSummary,
  NeedsYouTurn,
  ReviewTarget,
} from "../../../../shared/needsYou.ts";
import type { HostModel, SessionEntry } from "../../../store/hostModel.ts";
import { digestStarted, type Digest } from "../../constellation/model/index.ts";
import { isWorker, workerSessionsOf } from "../../constellation/model/workers.ts";
import { waitingOn } from "../../session/model/background.ts";
import type { ConstellationView } from "../../sessions/source.ts";
import { dataWantsLine } from "../../data/approval/model.ts";
import type { Inbox } from "./inbox.ts";
import { type HeldSummary, type PullRow, reviewOf } from "./review.ts";

export interface SummaryInput {
  readonly inbox: Inbox;
  /** The session the window shows, if any. */
  readonly focused: { readonly hostKey: string; readonly sessionId: string } | null;
  /** Working and Idle sessions (`turnsOf`); none when left out. */
  readonly turns?: ReadonlyArray<NeedsYouTurn>;
  /** Each session's latest agent notification (`notificationsOf`); none when left out. */
  readonly notifications?: ReadonlyArray<NeedsYouNotification>;
  /** The Review the window shows, if any. */
  readonly reviewing?: ReviewTarget | null;
}

/** A graph as its own stream delivered it; `digests` names the Lead Turns Polaris started. */
export interface TurnsView extends ConstellationView {
  readonly digests?: ReadonlyArray<Digest>;
}

export interface TurnsInput {
  readonly hosts: ReadonlyArray<HostView>;
  readonly models: Readonly<Record<string, HostModel>>;
  readonly views: Readonly<Record<string, ReadonlyArray<TurnsView>>>;
  /** The pull request list's rows, for the title a Review notification names; none when left out. */
  readonly pulls?: ReadonlyArray<PullRow>;
  /** The Risk Summaries the renderer holds, for a Reviewer's findings; none when left out. */
  readonly summaries?: ReadonlyArray<HeldSummary>;
}

/** The Daemon's current user Turn (`session.user-turns`), else the latest seen live. */
const userTurnOf = (entry: SessionEntry) => {
  const current = entry.session.currentUserTurn ?? null;

  if (current !== null) return { id: current.turnId, startedAt: current.startedAt };

  return entry.userTurn === undefined
    ? null
    : { id: entry.userTurn.id, startedAt: entry.userTurn.startedAt };
};

/** Constellation workers' sessions: their Lead reports on them, so their Turns aren't news. */
const workerSessions = (views: TurnsInput["views"]) =>
  workerSessionsOf(Object.values(views).flat());

/** Each Lead session's digests, by Host and session. */
const leadDigests = (views: TurnsInput["views"]) =>
  new Map(
    Object.entries(views).flatMap(([hostKey, list]) =>
      list.map(
        ({ constellation, digests }) =>
          [`${hostKey}\u0000${constellation.leadSessionId}`, digests ?? []] as const
      )
    )
  );

/** Every Working or Idle session outside a Constellation's workers, for Turn-ended notifications. */
export const turnsOf = ({
  hosts,
  models,
  views,
  pulls = [],
  summaries = [],
}: TurnsInput): Array<NeedsYouTurn> => {
  const workers = workerSessions(views);
  const digests = leadDigests(views);

  return hosts.flatMap((host) => {
    const model = models[host.key];

    if (model === undefined) return [];

    return [...model.sessions.values()].flatMap((entry): Array<NeedsYouTurn> => {
      const { id, state, title, harness } = entry.session;

      if ((state !== "working" && state !== "idle") || isWorker(entry.session, workers)) return [];
      const lead = digests.get(`${host.key}\u0000${id}`);
      const turnId = entry.lastTurnId ?? null;
      const userTurn = userTurnOf(entry);

      const turn: NeedsYouTurn = {
        hostKey: host.key,
        hostLabel: host.label,
        sessionId: id,
        title,
        harness: harnessHue(harness).name,
        state,
        reply: entry.session.lastReplyPreview ?? null,
        digestStarted: lead !== undefined && turnId !== null && digestStarted(lead, turnId),
        backgroundTasks: waitingOn(entry.session).length,
        userTurn,
        updatedAt: entry.session.updatedAt,
      };

      const review = reviewOf({
        hostKey: host.key,
        model,
        session: entry.session,
        userTurn,
        pulls,
        summaries,
      });

      return [review === undefined ? turn : { ...turn, review }];
    });
  });
};

/**
 * Every session's latest agent notification (MCP `notify`), for main to show once each; a
 * worker's are left out, as only its Needs You is the user's (ENG-586).
 */
export const notificationsOf = ({
  hosts,
  models,
  views = {},
}: Pick<TurnsInput, "hosts" | "models"> & {
  readonly views?: TurnsInput["views"];
}): Array<NeedsYouNotification> => {
  const workers = workerSessions(views);

  return hosts.flatMap((host) =>
    [...(models[host.key]?.sessions.values() ?? [])].flatMap((entry) =>
      entry.lastNotification === undefined || isWorker(entry.session, workers)
        ? []
        : [
            {
              hostKey: host.key,
              hostLabel: host.label,
              sessionId: entry.session.id,
              sessionTitle: entry.session.title,
              id: entry.lastNotification.id,
              title: entry.lastNotification.title,
              body: entry.lastNotification.body,
              automatic: entry.lastNotification.automatic,
              constellationId: entry.lastNotification.constellationId ?? null,
            },
          ]
    )
  );
};

export const toSummary = ({
  inbox,
  focused,
  turns = [],
  notifications = [],
  reviewing = null,
}: SummaryInput): NeedsYouSummary => {
  const waiting = inbox.waiting.map((w): NeedsYouSession => ({
    hostKey: w.hostKey,
    hostLabel: w.hostLabel,
    workspace: w.workspace,
    sessionId: w.entry.session.id,
    title: w.entry.session.title,
    harness: harnessHue(w.entry.session.harness).name,
    requests: w.requests.map((r) => ({
      requestId: r.id,
      kind: r.kind,
      // A Data Source Approval reads as its card does: "Backfill currency wants to read analytics".
      title: dataWantsLine(w.entry.session.title, r) ?? r.title,
      // A secret's reason may say where the value comes from; only its label leaves the renderer.
      detail: r.kind === "secret" ? null : r.detail,
      options: r.options,
    })),
  }));

  const interrupted = inbox.also
    .filter((a) => a.kind === "interrupted")
    .map((a): NeedsYouSession => ({
      hostKey: a.hostKey,
      hostLabel: a.hostLabel,
      workspace: a.workspace,
      sessionId: a.entry.session.id,
      title: a.entry.session.title,
      harness: harnessHue(a.entry.session.harness).name,
      requests: [],
    }));

  return {
    count: inbox.count,
    sessions: [...waiting, ...interrupted],
    focused,
    turns,
    notifications,
    reviewing,
  };
};
