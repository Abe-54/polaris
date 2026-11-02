/**
 * One Risk Summary: started (or the cached one answered), then the Rules and
 * the Reviewer in turn, the cost line, and its end. The Reviewer's layer runs
 * in its own read-only Agent Session and reports through `output.ts`.
 */
import {
  DomainEvent,
  LayerRun,
  type ResolvedReviewer,
  type ReviewContext,
  type ReviewCheckoutId,
  type ReviewerChoice,
  type ReviewerSettings,
  ReviewerRun,
  type ReviewSubject,
  RiskSummary,
  RiskSummaryId,
  RiskSummaryLayers,
  RiskSummaryRef,
  type SessionId,
  type WorkspaceId,
} from "@polaris/protocol";
import { changeWalkthrough, initialWalkthrough, walkthroughChoice } from "./walkthrough.ts";
import { Cause, Effect, Option, Result, Schema } from "effect";
import { interruptibleGitPromise } from "../git/interrupt.ts";
import { checkoutGitRaw } from "../git/review/refs.ts";
import { recordRulesLayer } from "../rules/index.ts";
import { EventStore } from "../store/EventStore.ts";
import { currentPlanLimitNote, reviewerCost } from "./cost.ts";
import { type ChangeDiff, readDiff } from "./diff.ts";
import { generatedPaths } from "./generated.ts";
import { readInstructions } from "./instructions.ts";
import {
  parseReviewerReply,
  type ReadLines,
  type ReviewerOutput,
  toRiskFindings,
} from "./output.ts";
import { repairPrompt, reviewPrompt } from "./prompt.ts";
import { carryForward, previousReviewerSession, previousSummary } from "./merge.ts";
import { reviewerShell } from "./policy.ts";
import { probeClaudeSandbox, unsandboxedReviewerNote } from "../harness/claude/sandbox.ts";
import { shortHostName } from "../service/hostName.ts";
import { type ReviewRange, resolveRange } from "./range.ts";
import { askFirst, changedLines, switchedOff } from "./when.ts";
import { continueReviewerSession, startReviewerSession, type TurnOutcome } from "./session.ts";
import { turnFailure } from "./launch.ts";

export interface RunRequest {
  readonly workspaceId: WorkspaceId;
  readonly subject: ReviewSubject;
  readonly checkoutId: ReviewCheckoutId | null;
  readonly since: string | null;
  readonly refresh: boolean;
  readonly context: ReviewContext | null;
  /** The Rules alone, as after each Agent Session Turn; skipped when the Turn changed nothing. */
  readonly rulesOnly?: boolean;
}

const commit = (events: ReadonlyArray<DomainEvent>) =>
  Effect.gen(function* () {
    const store = yield* EventStore;
    yield* store.commit({ commandId: null, decide: () => Effect.succeed(events) });
  }).pipe(Effect.orDie);

const agentLayer = (summaryId: RiskSummaryId, run: LayerRun) =>
  commit([DomainEvent.cases.RiskSummaryLayerChanged.make({ summaryId, layer: "agent", run })]);

const readSummary = (summaryId: RiskSummaryId) =>
  Effect.gen(function* () {
    const store = yield* EventStore;

    return yield* store.review.riskSummary(RiskSummaryRef.cases.ById.make({ summaryId }));
  });

const decoder = new TextDecoder();

/** A file's lines at head (`new`) or the diff's base (`old`), read from git's objects. */
export const linesAt =
  (cwd: string, base: string, head: string): ReadLines =>
  (path, side) =>
    interruptibleGitPromise(async () => {
      const result = await checkoutGitRaw(cwd, ["show", `${side === "new" ? head : base}:${path}`]);

      return result.code === 0 ? decoder.decode(result.stdout).split("\n") : null;
    });

/** True when `base` and `head` hold the same files (a Turn that changed nothing). */
const sameTree = (range: ReviewRange) =>
  interruptibleGitPromise(async () => {
    const result = await checkoutGitRaw(range.cwd, ["diff", "--quiet", range.base, range.head]);

    return result.code === 0;
  });

// ── Starting ────────────────────────────────────────────────────────────────

/** The summary to answer: the cached one for the key (unless refreshed or failed), else null. */
/**
 * The summary to answer: the cached one for the key, unless refreshed or
 * failed, or it skipped the Reviewer and this run would not (Rules after a
 * Turn, then the session opened in Review; a switch turned back on).
 */
const cached = (range: ReviewRange, refresh: boolean, plan: ReviewerPlan) =>
  Effect.gen(function* () {
    if (refresh) return null;
    const store = yield* EventStore;

    const summary = yield* store.review.riskSummary(
      RiskSummaryRef.cases.ByKey.make({ key: range.key })
    );

    if (summary === null || summary.status === "failed") return null;

    const runsReviewer = plan.resolved.choice !== null && plan.off === null;

    return summary.layers.agent.status === "skipped" && runsReviewer ? null : summary;
  });

/** The agent layer's note on the Rules run after each Agent Session Turn. */
export const RULES_AFTER_TURN =
  "Rules after this Turn. The Reviewer runs when you open the session in Review or accept its Turns.";

/** Who reviews this summary, and whether "When it runs" lets them now. */
export interface ReviewerPlan {
  readonly resolved: ResolvedReviewer;
  /** Why the Reviewer doesn't run by itself here (a switch is off); null when it does. */
  readonly off: string | null;
  /** Ask first above this many changed lines; null never asks. */
  readonly askAboveLines: number | null;
  /** Set when the change is over that threshold: the Reviewer waits for "Run reviewer". */
  readonly waiting: string | null;
}

/** The Reviewer that runs on this summary now, or null (none, switched off, or waiting). */
const runningChoice = (plan: ReviewerPlan) =>
  plan.off === null && plan.waiting === null ? plan.resolved.choice : null;

const agentAtStart = ({ resolved, off, waiting }: ReviewerPlan) => {
  if (resolved.choice === null) return LayerRun.make({ status: "skipped", note: resolved.note });

  if (off !== null) return LayerRun.make({ status: "skipped", note: off });

  return LayerRun.make({ status: "pending", note: waiting });
};

const reviewerRun = (choice: ReviewerChoice, sessionId: SessionId | null) =>
  ReviewerRun.make({
    harness: choice.harness,
    model: choice.model,
    effort: choice.effort,
    sessionId,
  });

interface SummaryOverview {
  walkthrough: NonNullable<RiskSummary["walkthrough"]>;
  deltaWalkthrough?: NonNullable<RiskSummary["deltaWalkthrough"]>;
  prompts: NonNullable<RiskSummary["prompts"]>;
}

const startedSummary = (
  request: RunRequest,
  range: ReviewRange,
  plan: ReviewerPlan,
  now: string,
  overview: {
    readonly walkthrough: NonNullable<RiskSummary["walkthrough"]>;
    readonly deltaWalkthrough?: NonNullable<RiskSummary["deltaWalkthrough"]>;
    readonly prompts: NonNullable<RiskSummary["prompts"]>;
  }
) => {
  const { resolved } = plan;
  const running = runningChoice(plan);
  const id = RiskSummaryId.make(`rs_${crypto.randomUUID()}`);

  const metadata: SummaryOverview = {
    walkthrough: overview.walkthrough,
    prompts: overview.prompts,
  };

  if (overview.deltaWalkthrough !== undefined)
    metadata.deltaWalkthrough = changeWalkthrough(overview.deltaWalkthrough, { fullSummaryId: id });

  return RiskSummary.make({
    ...metadata,
    id,
    key: range.key,
    workspaceId: range.workspaceId,
    subject: request.subject,
    checkoutId: range.checkoutId,
    status: "running",
    layers: RiskSummaryLayers.make({
      rules: LayerRun.make({ status: "pending", note: null }),
      agent: agentAtStart(plan),
    }),
    // Only a Reviewer that runs is named: a waiting or switched-off one isn't "Reviewed by".
    reviewer: running === null ? null : reviewerRun(running, null),
    cost: null,
    note: [range.note, resolved.note].filter((n) => n !== null).join(" ") || null,
    findings: [],
    startedAt: now,
    endedAt: null,
  });
};

/** What a failure says: a rejection's `reason`, else an error's `message`. */
const Said = Schema.Union([
  Schema.Struct({ reason: Schema.String }),
  Schema.Struct({ message: Schema.String }),
]);

const decodeSaid = Schema.decodeUnknownOption(Said);

/** A failure as a user reads it: the error's own words, never a stack. */
const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);

  return Option.match(decodeSaid(error), {
    onNone: () => String(error),
    onSome: (said) => ("reason" in said ? said.reason : said.message),
  });
};

// ── The Reviewer's layer ────────────────────────────────────────────────────

interface AgentInput {
  readonly summary: RiskSummary;
  readonly range: ReviewRange;
  readonly choice: ReviewerChoice;
  readonly context: ReviewContext | null;
}

const whyOf = (range: ReviewRange, context: ReviewContext | null): string | null => {
  if (context !== null) return context.body.trim() === "" ? null : context.body;

  return range.prompts.length === 0
    ? null
    : range.prompts.map((prompt, i) => `Prompt ${i + 1}:\n${prompt}`).join("\n\n");
};

/** The previous summary's open Reviewer Findings and session, for "only the new changes". */
const previousRun = (range: ReviewRange) =>
  Effect.gen(function* () {
    const previous = yield* previousSummary(range);

    return {
      findings: (previous?.findings ?? []).filter(
        (f) => f.source === "agent" && f.status === "open"
      ),
      sessionId: yield* previousReviewerSession(range),
    };
  });

/** The reply decoded, after one repair Turn if it didn't decode. */
const decodeWithRepair = (sessionId: SessionId, outcome: TurnOutcome) =>
  Effect.gen(function* () {
    const first = parseReviewerReply(outcome.reply ?? "");

    if (Result.isSuccess(first)) return first;
    const repaired = yield* continueReviewerSession(sessionId, repairPrompt(first.failure));

    return parseReviewerReply(repaired.reply ?? "");
  });

interface AgentResult {
  /** Null when it failed before its session started. */
  readonly sessionId: SessionId | null;
  readonly output: ReviewerOutput | null;
  readonly note: string | null;
}

const askReviewer = Effect.fn("askReviewer")(function* (input: AgentInput) {
  const { range, choice, summary } = input;
  const diff = yield* interruptibleGitPromise(() => readDiff(range.cwd, range.base, range.head));

  const instructions = yield* interruptibleGitPromise(() =>
    readInstructions({ cwd: range.cwd, head: range.head, repo: range.key.repo })
  );

  const generated = yield* interruptibleGitPromise(() =>
    generatedPaths({
      root: range.cwd,
      at: range.rulesAt,
      repo: range.key.repo,
      paths: diff.files.map((f) => f.path),
    })
  );

  const current = yield* readSummary(summary.id);
  const previous = yield* previousRun(range);

  const sandbox = probeClaudeSandbox();
  const shell = reviewerShell(choice.harness, () => sandbox);

  // A Claude Code Reviewer without the sandbox ran with no shell; say so and how to fix it.
  const shellNote =
    choice.harness === "claude" ? unsandboxedReviewerNote(sandbox, shortHostName()) : null;

  const prompt = reviewPrompt({
    subject: input.context === null ? range.title : `${range.title}: ${input.context.title}`,
    why: whyOf(range, input.context),
    instructions: instructions.text,
    ruleFindings: (current?.findings ?? []).filter((f) => f.source === "rule"),
    diff,
    generated,
    base: range.base,
    head: range.head,
    since: range.key.since,
    earlierFindings: previous.findings,
    shell,
  });

  const outcome =
    previous.sessionId === null
      ? yield* startReviewerSession({
          workspaceId: range.workspaceId,
          checkoutId: range.checkoutId,
          choice,
          title: `Reviewer · ${range.title}`,
          prompt,
        })
      : {
          sessionId: previous.sessionId,
          ...(yield* continueReviewerSession(previous.sessionId, prompt)),
        };

  const failure = turnFailure(choice.harness, outcome);

  if (failure !== null)
    return { sessionId: outcome.sessionId, output: null, note: failure } satisfies AgentResult;

  const decoded = yield* decodeWithRepair(outcome.sessionId, outcome);

  return {
    sessionId: outcome.sessionId,
    output: Result.isSuccess(decoded) ? decoded.success : null,
    note: Result.isSuccess(decoded)
      ? shellNote
      : "The Reviewer's reply couldn't be read, even after asking again.",
  } satisfies AgentResult;
});

/** Runs the Reviewer and records its Findings; the session it ran in, if any. */
const runAgentLayer = (input: AgentInput) =>
  Effect.gen(function* () {
    const { summary, range } = input;
    yield* agentLayer(summary.id, LayerRun.make({ status: "running", note: null }));

    const result = yield* askReviewer(input).pipe(
      Effect.catchCause((cause) =>
        Effect.as(Effect.logWarning("the Reviewer failed", cause), {
          sessionId: null,
          output: null,
          note: `The Reviewer couldn't run: ${causeMessage(cause)}`,
        } satisfies AgentResult)
      )
    );

    if (result.output === null) {
      yield* agentLayer(
        summary.id,
        LayerRun.make({ status: "failed", note: result.note ?? "The Reviewer couldn't run." })
      );

      return result.sessionId;
    }

    const converted = yield* toRiskFindings(
      result.output.findings,
      yield* interruptibleGitPromise(() => readDiff(range.cwd, range.base, range.head)),
      linesAt(range.cwd, range.base, range.head)
    );

    const dropped =
      converted.dropped > 0
        ? `${converted.dropped} of the Reviewer's findings pointed outside the diff and were left out.`
        : null;

    yield* commit([
      ...(converted.findings.length > 0
        ? [
            DomainEvent.cases.RiskFindingsRecorded.make({
              summaryId: summary.id,
              findings: converted.findings,
            }),
          ]
        : []),
      DomainEvent.cases.RiskSummaryLayerChanged.make({
        summaryId: summary.id,
        layer: "agent",
        run: LayerRun.make({
          status: "completed",
          note: [dropped, result.note].filter((n) => n !== null).join(" ") || null,
        }),
      }),
    ]);

    return result.sessionId;
  });

// ── The whole run ───────────────────────────────────────────────────────────

/** `choice` is the Reviewer that ran (or tried to); null when none did. */
const ended = (summary: RiskSummary, sessionId: SessionId | null, choice: ReviewerChoice | null) =>
  Effect.gen(function* () {
    const after = yield* readSummary(summary.id);
    const rulesFailed = after?.layers.rules.status === "failed";
    const agentFailed = after?.layers.agent.status !== "completed";

    const cost =
      choice === null || sessionId === null
        ? null
        : yield* reviewerCost(choice.harness, sessionId, summary.startedAt).pipe(
            Effect.catchCause(() => Effect.succeed(null))
          );

    const limitNote = choice === null ? null : yield* currentPlanLimitNote(choice.harness);
    const note = [summary.note, limitNote].filter((n) => n !== null).join(" ") || null;

    yield* commit([
      DomainEvent.cases.RiskSummaryEnded.make({
        summaryId: summary.id,
        status: rulesFailed && agentFailed ? "failed" : "completed",
        reviewer: choice === null ? null : reviewerRun(choice, sessionId),
        cost,
        note,
      }),
    ]);

    return !(rulesFailed && agentFailed);
  });

/** The layers of a started summary, then its end. Never fails: a broken layer is recorded. */
export const runLayers = (
  summary: RiskSummary,
  range: ReviewRange,
  input: {
    readonly plan: ReviewerPlan;
    readonly context: ReviewContext | null;
  }
) =>
  Effect.gen(function* () {
    yield* recordRulesLayer(summary.id, {
      cwd: range.cwd,
      base: range.base,
      head: range.head,
      mode: range.mode,
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("the Rules failed", cause)));

    const choice = runningChoice(input.plan);

    const sessionId =
      choice === null
        ? null
        : yield* runAgentLayer({ summary, range, choice, context: input.context });

    const since = range.key.since;

    if (since !== null) {
      yield* carryForward(summary, range, {
        before: linesAt(range.cwd, since, since),
        after: linesAt(range.cwd, range.base, range.head),
      });
    }

    return yield* ended(summary, sessionId, choice);
  });

const planningDiff = (range: ReviewRange, plan: ReviewerPlan, walkthroughRuns: boolean) =>
  !walkthroughRuns && (runningChoice(plan) === null || plan.askAboveLines === null)
    ? Effect.succeed<ChangeDiff>({ files: [] })
    : interruptibleGitPromise(() => readDiff(range.cwd, range.base, range.head));

export const startRun = (
  request: RunRequest,
  resolve: (
    workspaceId: WorkspaceId
  ) => Effect.Effect<{ readonly resolved: ResolvedReviewer; readonly settings: ReviewerSettings }>
) =>
  Effect.gen(function* () {
    const range = yield* resolveRange(request.subject, request.checkoutId, request.since);

    if (request.rulesOnly === true && (yield* sameTree(range))) {
      return { summary: null, range, plan: null };
    }

    const { resolved, settings } = yield* resolve(range.workspaceId);

    const plan: ReviewerPlan = {
      resolved,
      off:
        request.rulesOnly === true
          ? RULES_AFTER_TURN
          : switchedOff(request.subject, settings, request.refresh),
      askAboveLines: request.refresh ? null : settings.askAboveLines,
      waiting: null,
    };

    const existing = yield* cached(range, request.refresh, plan);

    if (existing !== null) return { summary: existing, range, plan: null };

    const walkChoice = walkthroughChoice(settings, resolved.choice);

    const off =
      request.rulesOnly === true || plan.off !== null || settings.walkthrough?.enabled === false;

    const diff = yield* planningDiff(range, plan, !off && walkChoice !== null);
    const lines = changedLines(diff);

    const waiting =
      runningChoice(plan) === null && walkChoice === null
        ? null
        : askFirst(lines, plan.askAboveLines);

    const initial = initialWalkthrough(range.key.head, walkChoice, {
      off,
      waiting: waiting !== null,
      lines,
      files: diff.files.length,
    });

    const store = yield* EventStore;
    const atHead = yield* store.review.riskSummariesAt(range.key.repo, range.key.head, 30);

    const same = atHead.find(
      (candidate) =>
        candidate.key.mergeBase === range.key.mergeBase &&
        candidate.walkthrough !== undefined &&
        ["writing", "ready", "failed"].includes(candidate.walkthrough.state)
    );

    const overview: SummaryOverview = {
      walkthrough: off ? initial : (same?.walkthrough ?? initial),
      prompts: range.promptViews,
    };

    if (range.key.since !== null)
      overview.deltaWalkthrough =
        atHead.find(
          (candidate) =>
            candidate.key.since === range.key.since && candidate.deltaWalkthrough?.state === "ready"
        )?.deltaWalkthrough ??
        initialWalkthrough(range.key.head, walkChoice, {
          off,
          waiting: waiting !== null,
          lines,
          files: diff.files.length,
          fromHead: range.key.since,
        });

    const summary = startedSummary(
      request,
      range,
      { ...plan, waiting },
      new Date().toISOString(),
      overview
    );

    yield* commit([DomainEvent.cases.RiskSummaryStarted.make({ summary })]);

    return { summary, range, plan: { ...plan, waiting } };
  });
