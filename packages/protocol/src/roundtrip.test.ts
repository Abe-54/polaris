/**
 * Every listed event, command and RPC payload survives the JSON wire. Legacy
 * decodes and bounds live next to each contract.
 */
import { expect, test } from "bun:test";
import { Schema } from "effect";
import {
  AcceptBranch,
  AcceptCommitted,
  AcceptDraft,
  AcceptPlan,
  AcceptRefused,
  AcceptRemote,
  AcceptTurn,
} from "./accept.ts";
import { SessionPlacement, Command } from "./commands.ts";
import { CommitMessageError, CommitMessageStreamItem } from "./commitMessage.ts";
import {
  AttemptCause,
  AttemptId,
  CheckReceipt,
  Claim,
  ConstellationId,
  ResourceLease,
  TaskId,
} from "./constellation/domain.ts";
import { ConstellationCommand } from "./constellation/commands.ts";
import { ConstellationOutboxEntry } from "./constellation/events.ts";
import { WorkerActivity, WorkerLiveness } from "./constellation/liveness.ts";
import { ConstellationStreamItem } from "./constellation/rpc.ts";
import {
  BackgroundTask,
  ContextUsage,
  ReplyStats,
  Subagent,
  TurnItem,
  Workspace,
} from "./domain.ts";
import { DomainEvent, EventEnvelope, StreamKey } from "./events.ts";
import { ChangedOnDisk, FileVersion } from "./files.ts";
import {
  HostId,
  RequestId,
  ReviewCheckoutId,
  RiskFindingId,
  Sequence,
  SessionId,
  SubagentId,
  TurnId,
  WorkspaceId,
} from "./ids.ts";
import { Model } from "./models.ts";
import {
  LayerRun,
  ResolvedReviewer,
  ReviewCheckoutBlocker,
  ReviewCheckoutStatus,
  ReviewContext,
  ReviewerChoice,
  ReviewerSettings,
  RiskSummaryRef,
} from "./review.ts";
import {
  checkout,
  feedback,
  finding,
  pullRequest,
  summary,
  turnsSubject,
  verdict,
} from "./review.testing.ts";
import { CommitAccepted, DiffFile, GitDiffSpec, HarnessModels } from "./rpc.ts";
import {
  LongContextTokens,
  PlanLimit,
  ReportedCost,
  TokenCounts,
  UsageBucket,
  UsageStreamItem,
} from "./usage.ts";
import { WorktreeSetup, WorktreeSetupRun } from "./worktreeSetup.ts";

type Codec = Schema.Top & {
  readonly DecodingServices: never;
  readonly EncodingServices: never;
};

interface Case {
  readonly name: string;
  readonly survives: () => boolean;
}

const json = <S extends Codec>(name: string, schema: S, value: S["Type"]): Case => ({
  name,
  survives: () => {
    const codec = Schema.toCodecJson(schema);
    const text = JSON.stringify(Schema.encodeSync(codec)(value));

    return Bun.deepEquals(Schema.decodeUnknownSync(Schema.fromJsonString(codec))(text), value);
  },
});

const failing = (cases: ReadonlyArray<Case>) =>
  cases.flatMap(({ name, survives }) => {
    try {
      return survives() ? [] : [name];
    } catch {
      return [`${name} (threw)`];
    }
  });

const s = SessionId.make("s");

const t = TurnId.make("t");

const at = "2026-01-01T00:00:00Z";

const host = HostId.make("host");

const c = ConstellationId.make("c");

const a = AttemptId.make("a");

const tokens = new TokenCounts({
  input: 10,
  cacheRead: 200,
  cacheWrite: 5,
  output: 40,
  reasoning: 12,
  cacheWrite1h: 2,
});

const subagent = (status: "working" | "completed", endedAt: string | null) =>
  new Subagent({
    id: SubagentId.make("toolu_1"),
    sessionId: s,
    turnId: t,
    parentItemId: "toolu_1",
    title: "Check frame timing at 180 Hz",
    agent: "Explore",
    model: "haiku",
    background: true,
    report: status === "completed" ? "**report**" : null,
    status,
    startedAt: at,
    endedAt,
  });

const claim = Schema.decodeUnknownSync(Claim)({
  branch: "polaris/c/A1",
  head: "abc123",
  commits: ["abc123"],
  receipts: [],
  notDone: [],
  followups: [],
  questions: [],
  outsideArea: [],
  decisions: [],
  summary: "Implemented A1",
});

const lease = ResourceLease.make({
  id: "request",
  hostId: host,
  resource: "bench",
  sessionId: null,
  attemptId: null,
  processId: 123,
  processIdentity: "Thu Oct 1 00:00:00 2026",
  command: ["bun", "run", "bench"],
  acquiredAt: "2026-10-01T00:00:00.000Z",
});

const setupRun = WorktreeSetupRun.make({
  id: "setup",
  constellationId: ConstellationId.make("graph"),
  taskId: TaskId.make("A"),
  command: "bun install",
  cwd: "/repo/A",
  status: "failed",
  output: "install failed",
  exitCode: 1,
  startedAt: "2026-10-02T00:00:00.000Z",
  endedAt: "2026-10-02T00:00:01.000Z",
});

const sessionEvents: ReadonlyArray<DomainEvent> = [
  DomainEvent.cases.SessionContextUsed.make({
    sessionId: s,
    usage: new ContextUsage({ usedTokens: 84_000, windowTokens: null }),
  }),
  DomainEvent.cases.SessionPinned.make({ sessionId: s, pinnedAt: "2026-10-12T04:00:00.000Z" }),
  DomainEvent.cases.SessionPinned.make({ sessionId: s, pinnedAt: null }),
  DomainEvent.cases.ApprovalWithdrawn.make({
    sessionId: s,
    requestId: RequestId.make("r"),
    withdrawnBy: "daemon",
    reason: "The Daemon restarted",
  }),
  DomainEvent.cases.SessionModelChanged.make({ sessionId: s, model: "gpt-5.5", effort: "high" }),
  DomainEvent.cases.TurnItemCompleted.make({
    sessionId: s,
    turnId: t,
    item: TurnItem.cases.UserMessage.make({ id: "steer:1", text: "also run lint" }),
    subagentId: null,
  }),
  DomainEvent.cases.TurnItemCompleted.make({
    sessionId: s,
    turnId: t,
    item: TurnItem.cases.AssistantMessage.make({
      id: "m:1",
      text: "Done.",
      stats: new ReplyStats({ outputTokens: 842, latencyMs: 1_200, durationMs: null }),
    }),
    subagentId: null,
  }),
  DomainEvent.cases.SubagentStarted.make({ subagent: subagent("working", null) }),
  DomainEvent.cases.SubagentEnded.make({ subagent: subagent("completed", at) }),
  DomainEvent.cases.SessionBackgroundTasksChanged.make({
    sessionId: s,
    tasks: [
      new BackgroundTask({ id: "a", kind: "subagent", description: "Research" }),
      new BackgroundTask({ id: "c", kind: "command", description: "Build" }),
    ],
  }),
  DomainEvent.cases.SessionSetupChanged.make({ sessionId: s, setup: setupRun }),
];

const reviewEvents: ReadonlyArray<DomainEvent> = [
  DomainEvent.cases.TurnsAccepted.make({
    sessionId: s,
    throughTurnId: TurnId.make("t2"),
    throughIndex: 1,
    revertLaterTurns: true,
    acceptedBy: "MacBook",
  }),
  DomainEvent.cases.TurnsReverted.make({
    sessionId: s,
    toTurnId: TurnId.make("t2"),
    revertedTurnIds: [TurnId.make("t3")],
    checkpoint: "refs/polaris/checkpoints/s/t2/after",
  }),
  DomainEvent.cases.SessionPullRequestLinked.make({ sessionId: s, pullRequest }),
  DomainEvent.cases.ReviewCheckoutOpened.make({ checkout }),
  DomainEvent.cases.ReviewCheckoutChanged.make({ checkout }),
  DomainEvent.cases.ReviewCheckoutRemoved.make({
    checkoutId: checkout.id,
    workspaceId: checkout.workspaceId,
  }),
  DomainEvent.cases.RiskSummaryStarted.make({ summary }),
  DomainEvent.cases.RiskSummaryLayerChanged.make({
    summaryId: summary.id,
    layer: "agent",
    run: new LayerRun({ status: "running", note: null }),
  }),
  DomainEvent.cases.RiskFindingsRecorded.make({
    summaryId: summary.id,
    findings: [finding("f2", "critical", 1)],
  }),
  DomainEvent.cases.RiskFindingResolved.make({
    summaryId: summary.id,
    findingId: RiskFindingId.make("f2"),
    resolution: "fixed",
    note: null,
  }),
  DomainEvent.cases.RiskSummaryEnded.make({
    summaryId: summary.id,
    status: "failed",
    reviewer: null,
    cost: null,
    note: "The Reviewer exited",
  }),
  DomainEvent.cases.VerdictRecorded.make({ verdict }),
];

const resourceEvents: ReadonlyArray<DomainEvent> = [
  DomainEvent.cases.ResourceLeaseQueued.make({
    hostId: host,
    resource: "bench",
    requestId: "request",
    sessionId: null,
    processId: 123,
    processIdentity: "Thu Oct 1 00:00:00 2026",
    command: ["bun", "run", "bench"],
  }),
  DomainEvent.cases.ResourceLeased.make({ lease }),
  DomainEvent.cases.ResourceLeaseCanceled.make({
    hostId: host,
    resource: "bench",
    requestId: "request",
    reason: "process exited",
  }),
  DomainEvent.cases.ResourceRemoved.make({ hostId: host, resource: "bench" }),
];

const reviewCommands: ReadonlyArray<Command> = [
  Command.cases.SendFeedback.make({ sessionId: s, feedback, attachments: [] }),
  Command.cases.AcceptTurns.make({ sessionId: s, throughTurnId: t, revertLaterTurns: false }),
  Command.cases.LinkPullRequest.make({ sessionId: s, pullRequest }),
  Command.cases.OpenReviewCheckout.make({
    checkoutId: checkout.id,
    workspaceId: checkout.workspaceId,
    subject: turnsSubject,
    head: null,
    base: null,
  }),
  Command.cases.ReportReviewHead.make({ checkoutId: checkout.id, head: "h", base: "b" }),
  Command.cases.UpdateReviewCheckout.make({ checkoutId: checkout.id, discardChanges: true }),
  Command.cases.RemoveReviewCheckout.make({ checkoutId: checkout.id, reason: "closed" }),
  Command.cases.RecordVerdict.make({
    verdictId: verdict.id,
    summaryId: summary.id,
    findingId: verdict.findingId,
    thumb: "down",
    reasons: ["false-positive"],
    text: null,
    scope: "everywhere",
  }),
];

const sol = ReviewerChoice.make({ harness: "codex", model: "gpt-6.1-sol", effort: "high" });

const liveness = new WorkerLiveness({
  current: new WorkerActivity({
    itemId: "tool:1",
    turnId: TurnId.make("turn:1"),
    command: "bun run test",
    startedAt: 1_759_360_000_000,
  }),
  lastOutputAt: 1_759_360_001_000,
  contextPercent: 85,
  queuedInput: 2,
});

const cases: ReadonlyArray<Case> = [
  ...[...sessionEvents, ...reviewEvents, ...resourceEvents].map((event) =>
    json(`DomainEvent ${event._tag}`, DomainEvent, event)
  ),
  ...reviewCommands.map((command) => json(`Command ${command._tag}`, Command, command)),
  json(
    "HarnessModels",
    HarnessModels,
    new HarnessModels({
      harness: "codex",
      models: [
        new Model({
          id: "gpt-5.5",
          name: "GPT-5.5",
          description: null,
          efforts: ["low", "medium", "high", "xhigh"],
          defaultEffort: "medium",
          isDefault: true,
        }),
      ],
      switchesModel: true,
      backgroundsCommands: false,
      fetchedAt: at,
    })
  ),
  json(
    "UsageChanged",
    UsageStreamItem,
    UsageStreamItem.cases.UsageChanged.make({
      indexedAt: "2026-01-01T01:00:00Z",
      indexing: false,
      buckets: [
        new UsageBucket({
          hour: at,
          harness: "claude",
          model: "claude-opus-5-5",
          sessionId: null,
          tokens,
          reportedCost: new ReportedCost({ tokens, usd: 0.12 }),
          longContext: [new LongContextTokens({ above: 200_000, tokens })],
        }),
      ],
    })
  ),
  json(
    "PlanLimitChanged",
    UsageStreamItem,
    UsageStreamItem.cases.PlanLimitChanged.make({
      limit: new PlanLimit({
        harness: "claude",
        kind: "five-hour",
        scope: null,
        windowMinutes: 300,
        usedPercent: 42,
        status: "ok",
        resetsAt: "2026-01-01T05:00:00Z",
        observedAt: "2026-01-01T00:30:00Z",
        plan: "max",
      }),
    })
  ),
  json(
    "ReviewCheckoutStatus",
    ReviewCheckoutStatus,
    new ReviewCheckoutStatus({
      checkout,
      dirtyPaths: ["a.ts"],
      localCommits: 0,
      sessionsInside: [],
      terminalsInside: 0,
      diskBytes: null,
    })
  ),
  json(
    "RiskSummaryRef ByKey",
    RiskSummaryRef,
    RiskSummaryRef.cases.ByKey.make({ key: summary.key })
  ),
  json(
    "GitDiffSpec Turns",
    GitDiffSpec,
    GitDiffSpec.cases.Turns.make({
      sessionId: s,
      firstTurnId: TurnId.make("t1"),
      lastTurnId: TurnId.make("t2"),
    })
  ),
  ...[
    ReviewCheckoutBlocker.cases.Dirty.make({ paths: ["x"] }),
    ReviewCheckoutBlocker.cases.LocalCommits.make({ count: 2 }),
    ReviewCheckoutBlocker.cases.ShallowClone.make({}),
    ReviewCheckoutBlocker.cases.FetchFailed.make({ message: "Permission denied (publickey)" }),
  ].map((blocker) => json(`ReviewCheckoutBlocker ${blocker._tag}`, ReviewCheckoutBlocker, blocker)),
  json(
    "ReviewerSettings",
    ReviewerSettings,
    ReviewerSettings.make({
      default: sol,
      workspaces: { "ws-1": sol },
      onPullRequests: true,
      onSessions: false,
      askAboveLines: 2000,
    })
  ),
  json(
    "ResolvedReviewer",
    ResolvedReviewer,
    ResolvedReviewer.make({ choice: null, source: "auto", note: "Rules only" })
  ),
  json("ReviewContext", ReviewContext, ReviewContext.make({ title: "Fix", body: "Fixes it." })),
  json(
    "SessionPlacement ReviewCheckout",
    SessionPlacement,
    SessionPlacement.cases.ReviewCheckout.make({ checkoutId: ReviewCheckoutId.make("rc-1") })
  ),
  json(
    "DiffFile generated",
    DiffFile,
    new DiffFile({
      path: "a",
      oldPath: null,
      status: "modified",
      offset: 0,
      length: 10,
      additions: 1,
      deletions: 0,
      binary: false,
      generated: true,
    })
  ),
  json(
    "AcceptPlan",
    AcceptPlan,
    new AcceptPlan({
      sessionId: s,
      root: "/repo",
      turns: [new AcceptTurn({ turnId: t, index: 0, title: "Fix it", files: 2 })],
      laterTurns: 1,
      branch: null,
      defaultBranch: "main",
      worktree: false,
      remote: new AcceptRemote({ name: "origin", url: "git@github.com:a/b.git" }),
      files: 2,
      additions: 3,
      deletions: 1,
    })
  ),
  json(
    "AcceptDraft",
    AcceptDraft,
    new AcceptDraft({
      title: "Fix it",
      body: "",
      prTitle: "Fix it",
      prBody: "",
      turnTitles: ["Fix it"],
      source: "template",
      note: "the agent didn't answer",
    })
  ),
  json(
    "AcceptCommitted",
    AcceptCommitted,
    new AcceptCommitted({ branch: "polaris/x", commits: ["abc"], base: "main" })
  ),
  json("AcceptRefused", AcceptRefused, new AcceptRefused({ reason: "no" })),
  json("CommitAccepted payload", CommitAccepted.payloadSchema, {
    sessionId: s,
    throughTurnId: t,
    branch: AcceptBranch.cases.Create.make({ name: "polaris/x" }),
    granularity: "per-turn",
    title: "Fix it",
    body: "",
    turnTitles: ["Fix it"],
  }),
  json(
    "CommitMessage Suggested",
    CommitMessageStreamItem,
    CommitMessageStreamItem.cases.Suggested.make({
      message: { subject: "feat: add", body: "" },
      truncated: true,
      thoughtMs: 12,
    })
  ),
  json(
    "CommitMessageError",
    CommitMessageError,
    new CommitMessageError({ reason: "needs-sign-in", message: "Sign in" })
  ),
  json("Claim", Claim, claim),
  json(
    "CheckReceipt Verified",
    CheckReceipt,
    CheckReceipt.cases.Verified.make({
      label: "tests",
      item: { hostId: HostId.make("h"), sessionId: s, turnId: t, itemId: "tool:1" },
    })
  ),
  json(
    "CheckReceipt Reported",
    CheckReceipt,
    CheckReceipt.cases.Reported.make({ label: "tests", text: "passed" })
  ),
  json(
    "EventEnvelope AttemptClaimed",
    EventEnvelope,
    new EventEnvelope({
      sequence: Sequence.make(10),
      occurredAt: "2026-10-01T00:00:00Z",
      commandId: null,
      event: DomainEvent.cases.AttemptClaimed.make({
        constellationId: c,
        revision: 3,
        attemptId: a,
        attemptRevision: 2,
        claim,
      }),
    })
  ),
  json(
    "StreamKey constellation",
    StreamKey,
    StreamKey.cases.constellation.make({ constellationId: c })
  ),
  json(
    "ConstellationOutboxEntry",
    ConstellationOutboxEntry,
    new ConstellationOutboxEntry({
      id: "outbox:1",
      constellationId: c,
      ownerHostId: HostId.make("lead-host"),
      workerHostId: HostId.make("worker-host"),
      sessionId: SessionId.make("worker"),
      attemptId: a,
      command: ConstellationCommand.cases.WorkerClaim.make({
        constellationId: c,
        attemptId: a,
        claim,
      }),
    })
  ),
  json(
    "AttemptCause MergeConflict",
    AttemptCause,
    AttemptCause.cases.MergeConflict.make({ ref: AttemptId.make("old"), base: "abc" })
  ),
  json(
    "LivenessChanged",
    ConstellationStreamItem,
    ConstellationStreamItem.cases.LivenessChanged.make({ attemptId: a, liveness })
  ),
  json(
    "ChangedOnDisk",
    ChangedOnDisk,
    new ChangedOnDisk({
      path: "/a",
      current: new FileVersion({ mtimeMs: 1.25, size: 4, hash: "abcd" }),
    })
  ),
  json(
    "Workspace with setup disabled",
    Workspace,
    new Workspace({
      id: WorkspaceId.make("w"),
      name: "repo",
      path: "/repo",
      isGitRepo: true,
      hidden: false,
      registeredAt: "2026-10-02T00:00:00.000Z",
      worktreeRoot: "/trees",
      worktreeSetup: WorktreeSetup.cases.Disabled.make({}),
    })
  ),
];

test("every listed event, command and RPC payload survives JSON", () => {
  expect(failing(cases)).toEqual([]);
});
