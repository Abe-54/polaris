import { useEffect, useMemo } from "react";
import { useStore } from "zustand";
import type { ReviewTarget } from "../../../../shared/needsYou.ts";
import { type ReviewSubject, useReviewSubject } from "../../../routes/review.ts";
import { useApp, useSelection } from "../../../shell/hooks.ts";
import { usePulls } from "../../pulls/store.ts";
import { riskStore } from "../../risk/data/riskStore.ts";
import { useSettleCoveredApprovals } from "../../data/approval/settle.ts";
import { publishSummary } from "../bridge.ts";
import { pruneDismissed } from "../dismissed.ts";
import { useInboxUntimedView } from "../hooks.ts";
import { pullRows } from "../model/review.ts";
import { notificationsOf, toSummary, turnsOf } from "../model/summary.ts";

const targetOf = (subject: ReviewSubject): ReviewTarget =>
  subject.kind === "pull"
    ? {
        kind: "pull",
        repo: { owner: subject.pull.repo.owner, name: subject.pull.repo.name },
        number: subject.pull.number,
        pullId: subject.pull.pullId,
      }
    : { kind: "session", hostKey: subject.hostKey, sessionId: subject.sessionId };

/** Mounted once in the app: keeps the main process's Needs You summary current. */
export const NeedsYouPublisher = () => {
  const { inbox, current } = useInboxUntimedView();
  const { pane, mode, settings, hostKey, sessionId } = useSelection();
  const hosts = useApp((s) => s.hosts);
  const models = useApp((s) => s.hostModels);
  const constellations = useApp((s) => s.constellations);
  const list = usePulls((s) => s.list);
  const pulls = useMemo(() => pullRows(list), [list]);
  const risks = useStore(riskStore);
  const subject = useReviewSubject();

  useSettleCoveredApprovals();

  // Whole records, not views: a Lead's digests tell its digest-started Turns apart.
  const views = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(constellations).map(([key, model]) => [key, [...model.byId.values()]])
      ),
    [constellations]
  );

  // A Reviewer's findings, for its notification: the summaries the Review view loaded.
  const summaries = useMemo(
    () =>
      Object.values(risks).flatMap((risk) =>
        risk.kind === "ready" ? [{ hostKey: risk.hostKey, summary: risk.summary }] : []
      ),
    [risks]
  );

  const turns = useMemo(
    () => turnsOf({ hosts, models, views, pulls, summaries }),
    [hosts, models, views, pulls, summaries]
  );

  const notifications = useMemo(
    () => notificationsOf({ hosts, models, views }),
    [hosts, models, views]
  );

  const summary = useMemo(() => {
    // Settings, Review and Edit cover the session pane: its session isn't on screen.
    const shown = pane === "session" && mode === "orchestrate" && settings === null;
    const focused = shown && hostKey !== null && sessionId !== null ? { hostKey, sessionId } : null;
    const reviewing = mode === "review" && settings === null && subject !== null;

    return toSummary({
      inbox,
      focused,
      turns,
      notifications,
      reviewing: reviewing ? targetOf(subject) : null,
    });
  }, [inbox, pane, mode, settings, hostKey, sessionId, turns, notifications, subject]);

  useEffect(() => publishSummary(summary), [summary]);
  // Dismissals whose session changed since are dropped, so the item stays back.
  useEffect(() => pruneDismissed(current), [current]);

  return null;
};
