/**
 * Review with a subject open (DESIGN.md, Review; Paper R1, R2, X-G): the queue with the
 * subject's files under it on the ground, then the subject's header, tabs and diff in one
 * panel and its Risk Summary in another. Pierre's worker pool lives while this is mounted.
 */
import { Horizon } from "@polaris/ui";
import { useState } from "react";
import type { OpenPull } from "../../../../shared/api.ts";
import {
  closeReviewSubject,
  openPull,
  openSessionReview,
  type ReviewSubject,
} from "../../../routes/review.ts";
import { useApp, useShellActions } from "../../../shell/hooks.ts";
import { useStore } from "zustand";
import { usePulls } from "../../pulls/store.ts";
import "../checkout/install.ts";
import { DiffWorkers } from "../../diffs/index.ts";
import { useDetailsFeed } from "../data/pullDetail.ts";
import { riskMark } from "../model/findings.ts";
import { queueGroups, type QueueRow, withoutPulls } from "../model/queue.ts";
import { clearDone, useAdvance, useDone, useMerged } from "../data/advance.ts";
import { setReviewedOpen, useLocalReviews, useReviewedOpen } from "../data/reviewedStore.ts";
import { QueueDone } from "./QueueDone.tsx";
import { sessionsOf } from "../model/sessions.ts";
import { subjectKey, surfaceStore } from "../surface.ts";
import { PullReview } from "./PullReview.tsx";
import { Queue } from "./Queue.tsx";
import { SessionReview } from "./SessionReview.tsx";
import { FilesSlotProvider } from "./filesSlot.tsx";
import "../../risk/install.ts";
// The session's accept action fills its slot (M2-A).
import "../../accept/install.ts";
import "../constellation/install.ts";
import { useWorkerQueue } from "../constellation/useWorkerQueue.ts";

export interface ReviewViewProps {
  readonly subject: ReviewSubject;
  /** Back to the pull request list. */
  readonly onBack: () => void;
}

const selectedId = (subject: ReviewSubject) =>
  subject.kind === "pull"
    ? (subject.pull.pullId ?? null)
    : `${subject.hostKey}:${subject.sessionId}`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const ReviewView = ({ subject, onBack }: ReviewViewProps) => {
  const actions = useShellActions();
  const list = usePulls((s) => s.list);
  const models = useApp((s) => s.hostModels);
  const hosts = useApp((s) => s.hosts.length);
  const workspaces = Object.values(models).reduce((n, m) => n + m.workspaces.size, 0);
  const workers = useWorkerQueue();
  const local = useLocalReviews();
  const reviewedOpen = useReviewedOpen();
  const done = useDone();
  const merged = useMerged();
  const groups = queueGroups(withoutPulls(list, merged), sessionsOf(models), workers, local);
  const selected = selectedId(subject);

  const surfaces = useStore(surfaceStore, (s) => s);

  useDetailsFeed();

  const markOf = (row: QueueRow) =>
    riskMark(
      surfaces[
        subjectKey(
          row.kind === "pull"
            ? { kind: "pull", pull: row.pull }
            : { kind: "session", hostKey: row.hostKey, sessionId: row.sessionId }
        )
      ]?.findings ?? []
    );

  const open = (row: QueueRow) => {
    clearDone();

    if (row.kind === "pull") openPull(actions, row.pull);
    else openSessionReview(actions, row.hostKey, row.sessionId);
  };

  useAdvance(groups, selected, open);

  const finished = subject.kind === "pull" && done !== null && done.pullId === selected;
  const [files, setFiles] = useState<HTMLElement | null>(null);

  return (
    <DiffWorkers>
      <FilesSlotProvider value={files}>
        <div className="relative isolate flex min-h-0 flex-1 gap-2 pr-2" data-testid="review-view">
          <Queue
            groups={groups}
            markOf={markOf}
            caption={`${plural(hosts, "host")} · ${plural(workspaces, "workspace")}`}
            selected={finished ? null : selected}
            onOpen={open}
            onOpenPull={(pull: OpenPull) => {
              clearDone();
              openPull(actions, pull);
            }}
            onList={() => {
              clearDone();
              closeReviewSubject();
              onBack();
            }}
            reviewedOpen={reviewedOpen}
            onReviewedOpen={setReviewedOpen}
            files={
              // Stars never behind text: the list is gone above the moon; its scroller pads clear.
              <div
                ref={setFiles}
                data-testid="review-files-slot"
                className="-mx-gap flex min-h-[140px] flex-1 flex-col [mask-image:linear-gradient(to_bottom,black_calc(100%-128px),transparent_calc(100%-72px))]"
              />
            }
          />
          {finished && subject.kind === "pull" ? (
            <QueueDone
              pull={subject.pull}
              group={done.group}
              moved={done.moved}
              onBack={clearDone}
            />
          ) : subject.kind === "pull" ? (
            <PullReview
              key={`${subject.pull.repo.owner}/${subject.pull.repo.name}#${subject.pull.number}`}
              subject={subject}
            />
          ) : (
            <SessionReview key={`${subject.hostKey}:${subject.sessionId}`} subject={subject} />
          )}
          <Horizon />
        </div>
      </FilesSlotProvider>
    </DiffWorkers>
  );
};
