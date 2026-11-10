import { describe, expect, test } from "bun:test";
import {
  type AgentSession,
  HostStreamItem,
  LayerRun,
  LineRange,
  PullRequestRef,
  RepoRef,
  ReviewCheckout,
  ReviewCheckoutId,
  ReviewerRun,
  ReviewSubject,
  RiskFinding,
  RiskFindingId,
  RiskSummary,
  RiskSummaryId,
  RiskSummaryKey,
  RiskSummaryLayers,
  SessionId,
  SessionSummary,
} from "@polaris/protocol";
import { seq, workspace } from "../../../store/fixtures.testing.ts";
import { applyHostItems, emptyHostModel } from "../../../store/hostModel.ts";
import { sessionWith } from "./inbox.testing.ts";
import { type HeldSummary, type PullRow, reviewOf } from "./review.ts";

const T0 = "2026-10-19T09:00:00.000Z";

const T1 = "2026-10-19T09:10:00.000Z";

const prCheckout = new ReviewCheckout({
  id: ReviewCheckoutId.make("rc12"),
  workspaceId: workspace.id,
  subject: ReviewSubject.cases.PullRequest.make({
    pullRequest: new PullRequestRef({
      repo: new RepoRef({ host: "github.com", owner: "Acme", name: "API" }),
      number: 12,
    }),
    baseRef: "main",
  }),
  path: "/tmp/proof.worktrees/.review/pr-12",
  state: "ready",
  blocked: null,
  head: "h1",
  mergeBase: "m1",
  latestHead: "h1",
  latestBase: "b1",
  reviewedHead: null,
  reviewedMergeBase: null,
  openedAt: T0,
  updatedAt: T0,
});

const reviewer = sessionWith("rv", {
  state: "idle",
  origin: "reviewer",
  title: "Reviewer · Pull request #12",
  cwd: prCheckout.path,
});

const reviewed = sessionWith("work", { state: "idle", title: "Fix the login form" });

const modelOf = (sessions: ReadonlyArray<AgentSession>) =>
  applyHostItems(emptyHostModel, [
    HostStreamItem.cases.Snapshot.make({
      sequence: seq(1),
      workspaces: [workspace],
      worktrees: [],
      sessions: sessions.map(
        (session) =>
          new SessionSummary({
            session,
            pendingApprovals: [],
            lastTurnPreview: null,
            subagents: [],
          })
      ),
      reviewCheckouts: [prCheckout],
    }),
  ]);

const pulls: ReadonlyArray<PullRow> = [
  { id: "PR_node_9", number: 9, title: "Bump deps", repo: "acme/api" },
  { id: "PR_node_12", number: 12, title: "Retry flaky uploads", repo: "acme/api" },
];

const finding = (id: string, severity: RiskFinding["severity"], status: RiskFinding["status"]) =>
  new RiskFinding({
    id: RiskFindingId.make(id),
    identity: id,
    source: "agent",
    ruleId: null,
    path: "src/a.ts",
    lines: new LineRange({ start: 1, end: 2, side: "new" }),
    severity,
    confidence: 0.9,
    title: "Unchecked error",
    reason: "",
    suggestion: null,
    status,
    resolution: null,
  });

const summaryEnded = (endedAt: string): HeldSummary => ({
  hostKey: "local",
  summary: new RiskSummary({
    id: RiskSummaryId.make(`sum-${endedAt}`),
    key: new RiskSummaryKey({
      repo: "github.com/acme/api",
      mergeBase: "m1",
      head: "h1",
      since: null,
    }),
    workspaceId: workspace.id,
    subject: prCheckout.subject,
    checkoutId: prCheckout.id,
    status: "completed",
    layers: new RiskSummaryLayers({
      rules: new LayerRun({ status: "completed", note: null }),
      agent: new LayerRun({ status: "completed", note: null }),
    }),
    reviewer: new ReviewerRun({
      harness: "claude",
      model: null,
      effort: null,
      sessionId: SessionId.make("rv"),
    }),
    cost: null,
    note: null,
    findings: [
      finding("f1", "critical", "open"),
      finding("f2", "low", "open"),
      finding("f3", "high", "dismissed"),
    ],
    startedAt: T0,
    endedAt,
  }),
});

const of = (
  session: AgentSession,
  others: ReadonlyArray<AgentSession> = [],
  extra: { pulls?: ReadonlyArray<PullRow>; summaries?: ReadonlyArray<HeldSummary> } = {}
) =>
  reviewOf({
    hostKey: "local",
    model: modelOf([session, ...others]),
    session,
    userTurn: { startedAt: T0 },
    pulls: extra.pulls ?? [],
    summaries: extra.summaries ?? [],
  });

describe("reviewOf", () => {
  test("an ordinary session is no Review", () => {
    expect(of(reviewed)).toBeUndefined();
  });

  test("a pull request's Reviewer: the pull request's title, and a click opens it", () => {
    expect(of(reviewer, [], { pulls })).toEqual({
      kind: "reviewer",
      change: "Retry flaky uploads",
      target: {
        kind: "pull",
        repo: { owner: "Acme", name: "API" },
        number: 12,
        pullId: "PR_node_12",
      },
      findings: null,
    });
  });

  test("a pull request the list doesn't have is named by its repository and number", () => {
    expect(of(reviewer)?.change).toBe("Acme/API #12");
  });

  test("an Agent Session's walkthrough opens that session's Review, new commits or not", () => {
    const walkthrough = (title: string) =>
      sessionWith("wt", { state: "idle", origin: "walkthrough", title, cwd: workspace.path });

    const target = { kind: "session" as const, hostKey: "local", sessionId: "work" };

    expect(of(walkthrough("Walkthrough · Fix the login form"), [reviewed])).toMatchObject({
      kind: "walkthrough",
      change: "Fix the login form",
      target,
    });

    expect(
      of(walkthrough("Walkthrough · Fix the login form · new commits"), [reviewed])?.target
    ).toEqual(target);
  });

  test("the subject the Daemon names wins over a title another session shares", () => {
    const renamed = sessionWith("renamed", { state: "idle", title: "Fix the login form, v2" });

    // A newer session carries the title the run was started under.
    const lookalike = sessionWith("lookalike", {
      state: "idle",
      title: "Fix the login form",
      updatedAt: "2026-10-19T10:00:00.000Z",
    });

    const run = sessionWith("named", {
      state: "idle",
      origin: "reviewer",
      title: "Reviewer · Fix the login form",
      cwd: workspace.path,
      reviewSubject: ReviewSubject.cases.SessionTurns.make({
        sessionId: SessionId.make("renamed"),
        firstTurnId: null,
        lastTurnId: null,
      }),
    });

    expect(of(run, [renamed, lookalike])).toMatchObject({
      change: "Fix the login form, v2",
      target: { kind: "session", hostKey: "local", sessionId: "renamed" },
    });
  });

  test("a Reviewer started before sessions carried their origin is known by its title", () => {
    const old = sessionWith("old", { state: "idle", title: "Reviewer · Fix the login form" });

    expect(of(old, [reviewed])?.kind).toBe("reviewer");
  });

  test("the open findings of this run's finished Risk Summary, not an earlier run's", () => {
    const earlier = summaryEnded("2026-10-19T08:00:00.000Z");

    expect(of(reviewer, [], { summaries: [summaryEnded(T1)] })?.findings).toEqual({
      open: 2,
      critical: 1,
    });

    expect(of(reviewer, [], { summaries: [earlier] })?.findings).toBeNull();
  });
});
