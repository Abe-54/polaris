/**
 * Review's centre pane with its tabs (Paper R9): Overview, Changes (the diff, kept mounted
 * so it keeps its place), Conversation, Commits and Checks. Every Review opens on Overview;
 * revealing a place in the diff switches to Changes.
 */
import { cn } from "@polaris/ui";
import { type ReactNode, useEffect, useState } from "react";
import type { PullDetailView } from "../../../../../shared/github.ts";
import { useStore } from "zustand";
import { useCommands, useShellActions } from "../../../../shell/hooks.ts";
import type { ReviewSubject } from "../../../../routes/review.ts";
import { runRiskSummary, useRisk } from "../../../risk/data/riskStore.ts";
import { runWalkthrough, stopWalkthrough } from "../data/actions.ts";
import { useRiskRequest } from "../../../risk/data/request.ts";
import { useLoadedPullDetail } from "../../data/pullDetail.ts";
import { emptySurface, type ReviewSlotProps, revealStore, surfaceStore } from "../../surface.ts";
import { overviewOf, useWalkthroughs } from "../data/overview.ts";
import { count } from "../model/copy.ts";
import { setCommitScope, useCommitScope } from "../model/scope.ts";
import {
  cycleTab,
  PULL_TABS,
  SESSION_TABS,
  setTab,
  type TabId,
  tabFigures,
  useTab,
} from "../model/tabs.ts";
import { newSince } from "../model/timeline.ts";
import type { PullOverviewView } from "../model/types.ts";
import { shortSha } from "../model/botSummary.ts";
import { Checks } from "./Checks.tsx";
import { Commits } from "./Commits.tsx";
import { Conversation } from "./Conversation.tsx";
import { PullOverview, type PullOverviewProps, SessionOverview } from "./OverviewTab.tsx";
import { TabBar } from "./TabBar.tsx";
import type { WalkthroughActions } from "./Walkthrough.tsx";
import type { PromptTurn } from "../model/prompts.ts";

export interface SessionInfo {
  readonly where: string;
  readonly scope: string;
  /** Each Daemon Turn's number as the UI shows it, by index, for the prompts. */
  readonly turns: ReadonlyMap<number, PromptTurn>;
  readonly onOpenSession: () => void;
}

export interface CentrePaneProps {
  readonly subjectKey: string;
  readonly slotProps: ReviewSlotProps;
  /** The diff, or what stands in for it. */
  readonly changes: ReactNode;
  readonly files: number | null;
  readonly viewed: number | null;
  readonly session: SessionInfo | null;
  /** The checkout's merge base: the first commit's parent when Commits narrows Changes. */
  readonly mergeBase: string | null;
}

const useNow = () => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);

    return () => clearInterval(timer);
  }, []);

  return now;
};

/** Revealing a place in the diff (a finding, a path, a comment) shows Changes. */
const useRevealShowsChanges = (subjectKey: string) => {
  const nonce = useStore(revealStore, (s) => s.request?.nonce ?? 0);
  const [seen, setSeen] = useState(nonce);

  if (nonce !== seen) {
    setSeen(nonce);
    setTab(subjectKey, "changes");
  }
};

const useTabKeys = (subjectKey: string, tabs: ReadonlyArray<TabId>, current: TabId) => {
  const commands = useCommands();

  useEffect(() => {
    return commands.register({
      "review.nextTab": { run: () => setTab(subjectKey, cycleTab(tabs, current, 1)) },
      "review.previousTab": { run: () => setTab(subjectKey, cycleTab(tabs, current, -1)) },
    });
  }, [commands, subjectKey, tabs, current]);
};

const ScopeStrip = ({ subjectKey }: { readonly subjectKey: string }) => {
  const scope = useCommitScope(subjectKey);

  if (scope === null) return null;

  return (
    <div
      className="border-hairline bg-surface-sunken gap-gap px-panel flex h-9 shrink-0 items-center border-b"
      data-testid="commit-scope"
    >
      <span className="text-caption text-text-subtle">Showing</span>
      <span className="text-code-inline text-text-default font-mono">{shortSha(scope.oid)}</span>
      <span className="text-caption text-text-default min-w-0 flex-1 truncate">
        {scope.headline}
      </span>
      <button
        type="button"
        onClick={() => setCommitScope(subjectKey, null)}
        className="text-caption text-text-default hover:text-text-strong cursor-default font-medium"
      >
        All changes
      </button>
    </div>
  );
};

const jumpLabelOf = (tab: TabId, newCommits: number) => {
  if (tab === "changes") return null;

  return newCommits > 0 ? `Review ${count(newCommits, "new commit")}` : "Review changes";
};

const Scroll = ({ tab, children }: { readonly tab: TabId; readonly children: ReactNode }) => (
  <div
    role="tabpanel"
    id={`review-panel-${tab}`}
    aria-labelledby={`review-tab-${tab}`}
    className="absolute inset-0 overflow-y-auto"
  >
    {children}
  </div>
);

/** Commits pushed since the viewer's last review, for "Review 2 new commits". */
const commitsSince = (overview: PullOverviewView | null) => {
  const oid = overview?.viewerLastReview?.commitOid ?? null;

  if (overview === null || oid === null) return 0;
  const at = overview.commits.findIndex((c) => c.oid === oid);

  return at === -1 ? 0 : overview.commits.length - 1 - at;
};

const newsOf = (overview: PullOverviewView | null) => {
  const news: Partial<Record<TabId, string>> = {};

  const fresh =
    overview === null ? [] : newSince(overview.timeline, overview.viewerLastReview?.at ?? null);

  if (fresh.length > 0) news.conversation = `${fresh.length} new`;

  return news;
};

const hintsOf = (files: number | null, viewed: number | null) => {
  const hints: Partial<Record<TabId, string>> = {};

  if (files !== null) hints.changes = `${count(files, "file")}, ${viewed ?? 0} viewed`;

  return hints;
};

/** The walkthrough's actions; "Not now" hides an ask for this head until the Review reopens. */
const useWalkthroughModel = (
  subjectKey: string,
  slotProps: ReviewSlotProps,
  pick: (tab: TabId) => void
) => {
  const actions = useShellActions();
  const walkthroughs = useWalkthroughs(subjectKey);
  const request = useRiskRequest(slotProps);
  const [notNow, setNotNow] = useState<string | null>(null);
  const risk = useRisk(subjectKey);
  const run = request === null ? null : () => void runRiskSummary(subjectKey, request, true);
  const ran = risk.kind === "ready" ? { hostKey: risk.hostKey, summaryId: risk.summary.id } : null;

  const actionsOf: WalkthroughActions = {
    onRun: run,
    onNotNow: () => setNotNow(walkthroughs.full?.head ?? ""),
    onStop: ran === null ? null : () => void stopWalkthrough(ran.hostKey, ran.summaryId),
    onRetry:
      ran === null
        ? run
        : () => void runWalkthrough(ran.hostKey, ran.summaryId, request?.context ?? null),
    onOtherHost: () => actions.openSettings("reviewer"),
    onReviewChanges: () => pick("changes"),
  };

  const asked = walkthroughs.full?.state === "waiting" && walkthroughs.full.head === notNow;

  return { ...actionsOf, walkthroughs: asked ? { ...walkthroughs, full: null } : walkthroughs };
};

interface PanelsProps {
  readonly tab: TabId;
  readonly subjectKey: string;
  readonly subject: ReviewSubject;
  readonly detail: PullDetailView | null;
  readonly overview: PullOverviewView | null;
  readonly paths: ReadonlyArray<string>;
  readonly now: number;
  readonly mergeBase: string | null;
  readonly pick: (tab: TabId) => void;
}

/** A pull request's Conversation, Commits and Checks. */
const PullPanels = ({
  tab,
  subjectKey,
  subject,
  detail,
  overview,
  paths,
  now,
  mergeBase,
  pick,
}: PanelsProps) => {
  if (overview === null || detail === null || subject.kind !== "pull") return null;

  if (tab === "conversation") {
    return (
      <Scroll tab="conversation">
        <Conversation
          pull={subject.pull}
          subjectKey={subjectKey}
          paths={paths}
          now={now}
          overview={overview}
          viewer={detail.viewerLogin}
          pending={detail.pendingReview !== null}
        />
      </Scroll>
    );
  }

  if (tab === "commits") {
    return (
      <Scroll tab="commits">
        <Commits
          subjectKey={subjectKey}
          commits={overview.commits}
          mergeBase={mergeBase}
          now={now}
          onPicked={() => pick("changes")}
        />
      </Scroll>
    );
  }

  return tab === "checks" ? (
    <Scroll tab="checks">
      <Checks runs={overview.checkRuns} />
    </Scroll>
  ) : null;
};

const ChangesPanel = ({
  shown,
  subjectKey,
  children,
}: {
  readonly shown: boolean;
  readonly subjectKey: string;
  readonly children: ReactNode;
}) => (
  <div
    role="tabpanel"
    id="review-panel-changes"
    aria-labelledby="review-tab-changes"
    aria-hidden={!shown}
    inert={!shown}
    className={cn("absolute inset-0 flex flex-col", !shown && "invisible")}
  >
    <ScopeStrip subjectKey={subjectKey} />
    {children}
  </div>
);

export const CentrePane = (props: CentrePaneProps) => {
  const { subjectKey, slotProps, changes, files, viewed, session, mergeBase } = props;
  const { subject } = slotProps;
  const tabs = session === null ? PULL_TABS : SESSION_TABS;
  const current = useTab(subjectKey);
  const tab = tabs.includes(current) ? current : "overview";
  const now = useNow();
  const paths = useStore(surfaceStore, (s) => (s[subjectKey] ?? emptySurface).paths);
  const detail = usePullDetailOf(subject);
  const overview = detail === null ? null : overviewOf(detail);
  const pick = (next: TabId) => setTab(subjectKey, next);
  const walkthrough = useWalkthroughModel(subjectKey, slotProps, pick);

  useRevealShowsChanges(subjectKey);
  useTabKeys(subjectKey, tabs, tab);

  const common = {
    ...walkthrough,
    subjectKey,
    paths,
    now,
    onConversation: () => pick("conversation"),
  };

  const panels = { tab, subjectKey, subject, detail, overview, paths, now, mergeBase, pick };

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="review-centre"
      data-tab={tab}
    >
      <TabBar
        tabs={tabs}
        current={tab}
        figures={tabFigures(files, session === null ? overview : null)}
        hints={hintsOf(files, viewed)}
        news={newsOf(overview)}
        onPick={pick}
        jumpLabel={jumpLabelOf(tab, commitsSince(overview))}
      />
      <div className="relative min-h-0 flex-1">
        <ChangesPanel shown={tab === "changes"} subjectKey={subjectKey}>
          {changes}
        </ChangesPanel>
        {tab === "overview" && (
          <Scroll tab="overview">
            <div className="mx-auto flex w-full max-w-[720px] flex-col px-5 py-4">
              {session === null ? (
                <PullOverviewPanel {...panels} common={common} />
              ) : (
                <SessionOverview {...common} {...session} />
              )}
            </div>
          </Scroll>
        )}
        <PullPanels {...panels} />
      </div>
    </div>
  );
};

const PullOverviewPanel = ({
  subject,
  detail,
  overview,
  common,
}: PanelsProps & { readonly common: Omit<PullOverviewProps, "pull" | "detail" | "overview"> }) =>
  subject.kind === "pull" && detail !== null && overview !== null ? (
    <PullOverview {...common} pull={subject.pull} detail={detail} overview={overview} />
  ) : (
    <p className="text-caption text-text-subtle py-6 text-center">Reading the pull request…</p>
  );

const usePullDetailOf = (subject: ReviewSubject) =>
  useLoadedPullDetail(
    subject.kind === "pull" ? subject.pull : { repo: { owner: "", name: "" }, number: 0 }
  );
