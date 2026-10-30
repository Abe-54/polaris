/**
 * The Review domain (CONTEXT.md: Review, Review Checkout, Risk Summary, Risk
 * Finding, Severity, Verdict, Reviewer). Decisions: Linear ENG-185 and
 * ENG-218–230; the protocol README's "Review" section maps them here.
 */
import { Effect, Schema } from "effect";
import { HarnessKind } from "./harnesses.ts";
import {
  ReviewCheckoutId,
  RiskFindingId,
  RiskSummaryId,
  SessionId,
  Timestamp,
  TurnId,
  VerdictId,
  WorkspaceId,
} from "./ids.ts";
import { ModelId, ReasoningEffort } from "./models.ts";

// ── Subjects ────────────────────────────────────────────────────────────────

/** A repository on a code host, as GitHub names it. GitHub and GHE only in M2. */
export class RepoRef extends Schema.Class<RepoRef>("RepoRef")({
  /** `github.com`, or a GitHub Enterprise host. */
  host: Schema.String,
  owner: Schema.String,
  name: Schema.String,
}) {}

/** `host/owner/name`, lowercased: the key Risk Summaries and Verdicts are kept under. */
export const repoKey = (repo: RepoRef): string =>
  `${repo.host}/${repo.owner}/${repo.name}`.toLowerCase();

export class PullRequestRef extends Schema.Class<PullRequestRef>("PullRequestRef")({
  /** The base repository, where `refs/pull/<number>/head` lives. */
  repo: RepoRef,
  number: Schema.Int,
}) {}

/**
 * What a Review judges: an open pull request, or an Agent Session's Turns
 * (one of them, a contiguous run, or all of them).
 */
export const ReviewSubject = Schema.TaggedUnion({
  PullRequest: {
    pullRequest: PullRequestRef,
    /** The base branch, e.g. `main`. */
    baseRef: Schema.String,
  },
  SessionTurns: {
    sessionId: SessionId,
    /** Null: from the session's first Turn. */
    firstTurnId: Schema.NullOr(TurnId),
    /** Null: through its latest Turn. */
    lastTurnId: Schema.NullOr(TurnId),
  },
});

export type ReviewSubject = typeof ReviewSubject.Type;

/** Lines of a file in a diff, 1-based and inclusive, on its new or old side. */
export class LineRange extends Schema.Class<LineRange>("LineRange")({
  start: Schema.Int,
  end: Schema.Int,
  side: Schema.Literals(["new", "old"]),
}) {}

// ── Review Checkouts ────────────────────────────────────────────────────────

/**
 * - `fetching`: being fetched and checked out (on open, and on update).
 * - `ready`: the worktree holds `head`.
 * - `stale`: the code host reported a newer head; an update is offered, never done implicitly.
 * - `blocked`: an update or removal can't go ahead (see `ReviewCheckout.blocked`).
 * - `removing`: removal asked for (merged, closed, or the user); it ends in `ReviewCheckoutRemoved`.
 */
export const ReviewCheckoutState = Schema.Literals([
  "fetching",
  "ready",
  "stale",
  "blocked",
  "removing",
]);

export type ReviewCheckoutState = typeof ReviewCheckoutState.Type;

/** Why a Review Checkout is `blocked`. */
export const ReviewCheckoutBlocker = Schema.TaggedUnion({
  /** Modified or untracked files (ignored files don't count). */
  Dirty: { paths: Schema.Array(Schema.String) },
  /** Commits made on the checkout's detached HEAD. */
  LocalCommits: { count: Schema.Int },
  /** An Agent Session works in it, or a terminal is open in it. */
  InUse: { sessionIds: Schema.Array(SessionId), terminals: Schema.Int },
  /** The base commit is missing from a shallow clone; fetching full history is the user's call. */
  ShallowClone: {},
  /** The fetch failed with the Host's own git credentials (no access, SSO, no ssh agent). */
  FetchFailed: { message: Schema.String },
});

export type ReviewCheckoutBlocker = typeof ReviewCheckoutBlocker.Type;

export class ReviewCheckoutBlock extends Schema.Class<ReviewCheckoutBlock>("ReviewCheckoutBlock")({
  /** What was blocked. */
  during: Schema.Literals(["fetch", "update", "remove"]),
  blocker: ReviewCheckoutBlocker,
}) {}

/**
 * A detached, locked worktree on the Host holding the changes under Review,
 * at `<worktreeRoot>/.review/pr-<n>` for a pull request. Every git call in it
 * runs with hooks off.
 */
export class ReviewCheckout extends Schema.Class<ReviewCheckout>("ReviewCheckout")({
  id: ReviewCheckoutId,
  workspaceId: WorkspaceId,
  subject: ReviewSubject,
  path: Schema.String,
  state: ReviewCheckoutState,
  /** Set while `blocked`. */
  blocked: Schema.NullOr(ReviewCheckoutBlock),
  /** The commit checked out; null until the first fetch completes. */
  head: Schema.NullOr(Schema.String),
  /** `merge-base(base, head)` for `head`. */
  mergeBase: Schema.NullOr(Schema.String),
  /** The newest head and base the code host reported (the Client relays them). */
  latestHead: Schema.String,
  latestBase: Schema.String,
  /** The head and merge base the last completed Risk Summary covered (`only new changes`). */
  reviewedHead: Schema.NullOr(Schema.String),
  reviewedMergeBase: Schema.NullOr(Schema.String),
  openedAt: Timestamp,
  updatedAt: Timestamp,
}) {}

/** What `review.checkoutStatus` finds when it looks, beyond the recorded state. */
export class ReviewCheckoutStatus extends Schema.Class<ReviewCheckoutStatus>(
  "ReviewCheckoutStatus"
)({
  checkout: ReviewCheckout,
  dirtyPaths: Schema.Array(Schema.String),
  localCommits: Schema.Int,
  sessionsInside: Schema.Array(SessionId),
  terminalsInside: Schema.Int,
  /** The worktree's size on disk, when measured. */
  diskBytes: Schema.NullOr(Schema.Int),
}) {}

// ── Risk Findings ───────────────────────────────────────────────────────────

/**
 * Exactly four (CONTEXT.md: Severity). They map 1:1 onto P0–P3 internally;
 * anything a user reads uses the names.
 */
export const Severity = Schema.Literals(["critical", "high", "medium", "low"]);

export type Severity = typeof Severity.Type;

/** Ranking order: Critical first. */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Classifiers (Jev) are M6; the source is listed so their Findings decode on older builds. */
export const FindingSource = Schema.Literals(["rule", "classifier", "agent"]);

export type FindingSource = typeof FindingSource.Type;

export const FindingStatus = Schema.Literals(["open", "dismissed", "resolved"]);

export type FindingStatus = typeof FindingStatus.Type;

/**
 * Why a Finding is Resolved: the Reviewer withdrew it after a follow-up, or
 * a later Risk Summary of the same Review no longer finds its identity.
 */
export const FindingResolution = Schema.Literals(["withdrawn", "fixed"]);

export type FindingResolution = typeof FindingResolution.Type;

export class RiskFinding extends Schema.Class<RiskFinding>("RiskFinding")({
  id: RiskFindingId,
  /**
   * Stable across commits: a hash of source, rule id, file and the flagged
   * code (whitespace-normalised) with a few lines of context. Never line numbers.
   */
  identity: Schema.String,
  source: FindingSource,
  /** The rule's id for a Rule Finding; null for the Reviewer's. */
  ruleId: Schema.NullOr(Schema.String),
  path: Schema.String,
  lines: LineRange,
  severity: Severity,
  /** 0–1; deterministic rules report 1. Non-Critical Findings under 0.5 are dimmed. */
  confidence: Schema.Number,
  title: Schema.String,
  reason: Schema.String,
  /** A suggested change, as replacement text for `lines`. */
  suggestion: Schema.NullOr(Schema.String),
  status: FindingStatus,
  resolution: Schema.NullOr(FindingResolution),
}) {}

// ── Risk Summaries ──────────────────────────────────────────────────────────

/**
 * What a Risk Summary covers, so one Host's summary can serve a checkout of
 * the same change on another. For a Turn, `mergeBase` and `head` are its
 * before and after checkpoints' commits.
 */
export class RiskSummaryKey extends Schema.Class<RiskSummaryKey>("RiskSummaryKey")({
  /** `repoKey` for a pull request; the Workspace's path for an Agent Session. */
  repo: Schema.String,
  mergeBase: Schema.String,
  head: Schema.String,
  /** For "only the new changes": the head the previous summary covered; null for a full one. */
  since: Schema.NullOr(Schema.String),
}) {}

export const LayerStatus = Schema.Literals([
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
]);

export type LayerStatus = typeof LayerStatus.Type;

export class LayerRun extends Schema.Class<LayerRun>("LayerRun")({
  status: LayerStatus,
  /** Why it failed or was skipped, as a user reads it. */
  note: Schema.NullOr(Schema.String),
}) {}

/** The Reviewer that wrote the Agent part (CONTEXT.md: Reviewer). */
export class ReviewerRun extends Schema.Class<ReviewerRun>("ReviewerRun")({
  harness: HarnessKind,
  model: Schema.NullOr(ModelId),
  effort: Schema.NullOr(ReasoningEffort),
  /** The Reviewer's own read-only Agent Session ("Reviewer · <PR>"), which follow-ups continue. */
  sessionId: Schema.NullOr(SessionId),
}) {}

/**
 * What the Client knows about a pull request and the Daemon can't fetch (the
 * GitHub token stays in the Desktop App): its title and description.
 */
export class ReviewContext extends Schema.Class<ReviewContext>("ReviewContext")({
  title: Schema.String,
  body: Schema.String,
}) {}

/** A Reviewer as Settings picks it: Harness, Model and effort (null: their defaults). */
export class ReviewerChoice extends Schema.Class<ReviewerChoice>("ReviewerChoice")({
  harness: HarnessKind,
  model: Schema.NullOr(ModelId),
  effort: Schema.NullOr(ReasoningEffort),
}) {}

/** The automatic picks, best first: Claude Code Opus 5.5 high, then Codex GPT-6.1-Sol. */
export const AUTO_REVIEWERS: ReadonlyArray<ReviewerChoice> = [
  ReviewerChoice.make({ harness: "claude", model: "claude-opus-5-5", effort: "high" }),
  ReviewerChoice.make({ harness: "codex", model: "gpt-6.1-sol", effort: null }),
];

/**
 * Settings → Harnesses → Reviewer, kept on the Host (capability
 * `review.reviewer-settings`): a default, and overrides keyed by Workspace id.
 * A null default picks automatically (`ResolvedReviewer`).
 */
export class WalkthroughSettings extends Schema.Class<WalkthroughSettings>("WalkthroughSettings")({
  enabled: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
    Schema.withConstructorDefault(Effect.succeed(true))
  ),
  harness: Schema.NullOr(HarnessKind).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null))
  ),
  model: Schema.NullOr(ModelId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null))
  ),
  effort: Schema.NullOr(ReasoningEffort).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null))
  ),
}) {}

export class ReviewerSettings extends Schema.Class<ReviewerSettings>("ReviewerSettings")({
  walkthrough: Schema.optionalKey(WalkthroughSettings),
  default: Schema.NullOr(ReviewerChoice),
  workspaces: Schema.Record(Schema.String, ReviewerChoice),
  /** When it runs: a pull request when its Review opens (kept per head commit). */
  onPullRequests: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
    Schema.withConstructorDefault(Effect.succeed(true))
  ),
  /** When it runs: an Agent Session when opened in Review or its Turns are accepted. */
  onSessions: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
    Schema.withConstructorDefault(Effect.succeed(true))
  ),
  /** Ask first above this many changed lines (rules still run; the Reviewer waits for "Run reviewer"); null never asks. */
  askAboveLines: Schema.NullOr(Schema.Int).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(2000)),
    Schema.withConstructorDefault(Effect.succeed(2000))
  ),
}) {}

/**
 * The Reviewer a Workspace's Reviews run: its override, else the default,
 * else automatic (Claude Code Opus 5.5 high, else Codex GPT-6.1-Sol). Null
 * when none is available: Reviews are Rules only, and `note` says so.
 */
export class ResolvedReviewer extends Schema.Class<ResolvedReviewer>("ResolvedReviewer")({
  choice: Schema.NullOr(ReviewerChoice),
  source: Schema.Literals(["workspace", "settings", "auto"]),
  note: Schema.NullOr(Schema.String),
}) {}

/** The cost line: "Reviewed by Codex · GPT-6.1-Sol · 182k tokens · ~$0.40". */
export class ReviewCost extends Schema.Class<ReviewCost>("ReviewCost")({
  tokens: Schema.Int,
  /** Estimated; null when the Harness reports no price. */
  costUsd: Schema.NullOr(Schema.Number),
}) {}

export const RiskSummaryStatus = Schema.Literals(["running", "completed", "failed"]);

export type RiskSummaryStatus = typeof RiskSummaryStatus.Type;

export class RiskSummaryLayers extends Schema.Class<RiskSummaryLayers>("RiskSummaryLayers")({
  rules: LayerRun,
  agent: LayerRun,
}) {}

export const SummaryLayer = Schema.Literals(["rules", "agent"]);

export type SummaryLayer = typeof SummaryLayer.Type;

/** Which part of the system an Intent Group touches; Clients give each a neutral glyph. */
export const IntentCategory = Schema.Literals([
  "ui",
  "api",
  "core",
  "data",
  "cli",
  "security",
  "tests",
  "docs",
  "examples",
  "deps",
  "build",
  "scripts",
  "config",
  "i18n",
  "assets",
  "other",
]);

export type IntentCategory = typeof IntentCategory.Type;

/** A Walkthrough's group of changed files that share one intent; every file is in exactly one. */
export class IntentGroup extends Schema.Class<IntentGroup>("IntentGroup")({
  key: Schema.String,
  label: Schema.String,
  /** Why, in one to three sentences of Markdown. */
  summary: Schema.String,
  category: IntentCategory,
  /** The whole group deserves extra care: it borrows the Critical treatment. */
  critical: Schema.Boolean,
  paths: Schema.Array(Schema.String),
}) {}

/** The separate read-only walkthrough, persisted with the Risk Summary for its head. */
export class Walkthrough extends Schema.Class<Walkthrough>("Walkthrough")({
  /** Review priority order; absent until the Walkthrough returned a grouping that covers the change. */
  groups: Schema.optionalKey(Schema.Array(IntentGroup)),
  state: Schema.Literals(["off", "waiting", "writing", "ready", "failed"]),
  markdown: Schema.String,
  head: Schema.String,
  fromHead: Schema.NullOr(Schema.String),
  fullSummaryId: Schema.NullOr(RiskSummaryId),
  harness: Schema.NullOr(HarnessKind),
  model: Schema.NullOr(ModelId),
  effort: Schema.NullOr(ReasoningEffort),
  sessionId: Schema.NullOr(SessionId),
  lines: Schema.Int,
  tokensEstimate: Schema.NullOr(Schema.Int),
  filesRead: Schema.Int,
  filesTotal: Schema.Int,
  startedAt: Schema.NullOr(Timestamp),
  durationMs: Schema.NullOr(Schema.Number),
  tokens: Schema.NullOr(Schema.Int),
  reason: Schema.NullOr(Schema.String),
  evidence: Schema.NullOr(Schema.String),
}) {}

export class ReviewPrompt extends Schema.Class<ReviewPrompt>("ReviewPrompt")({
  turnIndex: Schema.Int,
  prompt: Schema.String,
  files: Schema.Int,
}) {}

export class RiskSummary extends Schema.Class<RiskSummary>("RiskSummary")({
  walkthrough: Schema.optionalKey(Walkthrough),
  deltaWalkthrough: Schema.optionalKey(Walkthrough),
  prompts: Schema.optionalKey(Schema.Array(ReviewPrompt)),
  id: RiskSummaryId,
  key: RiskSummaryKey,
  workspaceId: WorkspaceId,
  subject: ReviewSubject,
  checkoutId: Schema.NullOr(ReviewCheckoutId),
  status: RiskSummaryStatus,
  layers: RiskSummaryLayers,
  reviewer: Schema.NullOr(ReviewerRun),
  cost: Schema.NullOr(ReviewCost),
  /** E.g. "Rules only: no Reviewer is available", or a Plan Limit note. */
  note: Schema.NullOr(Schema.String),
  /** In the order they were recorded; rank with `rankFindings`. */
  findings: Schema.Array(RiskFinding),
  startedAt: Timestamp,
  endedAt: Schema.NullOr(Timestamp),
}) {}

/** Severity, then confidence (highest first), then source order (rules before the agent). */
export const rankFindings = (findings: ReadonlyArray<RiskFinding>): ReadonlyArray<RiskFinding> =>
  findings.toSorted(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.confidence - a.confidence ||
      FindingSource.literals.indexOf(a.source) - FindingSource.literals.indexOf(b.source)
  );

/** Which Risk Summary to read: by id, or the latest for a key. */
export const RiskSummaryRef = Schema.TaggedUnion({
  ById: { summaryId: RiskSummaryId },
  ByKey: { key: RiskSummaryKey },
  /**
   * The newest summary of `repo` at `head`, full or incremental (an incremental one
   * carries the earlier Findings forward); capability `review.latest-summary`.
   */
  LatestAt: { repo: Schema.String, head: Schema.String },
});

export type RiskSummaryRef = typeof RiskSummaryRef.Type;

// ── Verdicts ────────────────────────────────────────────────────────────────

export const VerdictThumb = Schema.Literals(["up", "down"]);

export type VerdictThumb = typeof VerdictThumb.Type;

/**
 * A thumbs-down's reason badges, fixed in M2: "False positive", "Not
 * important", "Intended", "Already handled", "Wrong severity", "Out of scope", "Other".
 */
export const VerdictReason = Schema.Literals([
  "false-positive",
  "not-important",
  "intended",
  "already-handled",
  "wrong-severity",
  "out-of-scope",
  "other",
]);

export type VerdictReason = typeof VerdictReason.Type;

/** "this change", "this repo", "everywhere". */
export const VerdictScope = Schema.Literals(["change", "repo", "everywhere"]);

export type VerdictScope = typeof VerdictScope.Type;

/** The Finding as it was judged, kept with the Verdict so learning never needs the summary. */
export class JudgedFinding extends Schema.Class<JudgedFinding>("JudgedFinding")({
  identity: Schema.String,
  source: FindingSource,
  ruleId: Schema.NullOr(Schema.String),
  path: Schema.String,
  severity: Severity,
  title: Schema.String,
}) {}

/**
 * The user's thumbs on a Risk Finding, kept on the Host keyed by repo
 * (CONTEXT.md: Verdict). In M2 a thumbs-down only moves the Finding to its
 * Review's Dismissed group; Risk Memory (M6) learns from these.
 */
export class Verdict extends Schema.Class<Verdict>("Verdict")({
  id: VerdictId,
  /** `RiskSummaryKey.repo` of the summary it was given in. */
  repo: Schema.String,
  summaryId: RiskSummaryId,
  findingId: RiskFindingId,
  finding: JudgedFinding,
  thumb: VerdictThumb,
  /** Empty for a thumbs-up. */
  reasons: Schema.Array(VerdictReason),
  /** The "Other" text, or a note. */
  text: Schema.NullOr(Schema.String),
  scope: VerdictScope,
  /** The device label of the Client that recorded it. */
  recordedBy: Schema.String,
  recordedAt: Timestamp,
}) {}

// ── Feedback for Agent Sessions ─────────────────────────────────────────────

/** One comment on an Agent Session's diff, quoting the lines it is about. */
export class FeedbackComment extends Schema.Class<FeedbackComment>("FeedbackComment")({
  /** Chosen by the Client, so the diff can mark it "sent with Turn N". */
  id: Schema.String,
  path: Schema.String,
  lines: LineRange,
  /** The quoted code, as the diff showed it. */
  code: Schema.String,
  note: Schema.String,
  /** Set when drafted from a Finding's "Comment on this". */
  findingId: Schema.NullOr(RiskFindingId),
}) {}

/** A draft batch sent as one Turn: the message first, then each comment quoted. */
export class FeedbackBatch extends Schema.Class<FeedbackBatch>("FeedbackBatch")({
  message: Schema.NullOr(Schema.String),
  comments: Schema.Array(FeedbackComment),
}) {}

const lineLabel = (lines: LineRange): string =>
  lines.start === lines.end ? `${lines.start}` : `${lines.start}-${lines.end}`;

const fence = (code: string): string => {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((run) => run[0].length));

  return "`".repeat(longest + 1);
};

/**
 * The prompt a feedback batch sends: the message, then each comment as
 * `path:lines`, the quoted code and the note. Clients use it to preview the Turn.
 */
export const feedbackPrompt = (batch: FeedbackBatch): string => {
  const parts: Array<string> = [];

  if (batch.message !== null && batch.message.trim() !== "") parts.push(batch.message.trim());

  for (const comment of batch.comments) {
    const marker = fence(comment.code);
    const side = comment.lines.side === "old" ? " (removed lines)" : "";

    parts.push(
      [
        `${comment.path}:${lineLabel(comment.lines)}${side}`,
        marker,
        comment.code,
        marker,
        comment.note.trim(),
      ].join("\n")
    );
  }

  return parts.join("\n\n");
};
