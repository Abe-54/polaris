/**
 * The decider's Review commands (protocol README, "Review"): feedback Turns
 * and accepting Turns go through the session machine, Review Checkouts
 * through the checkout machine (`checkout.ts`), Verdicts are recorded as given.
 */
import { join } from "node:path";
import {
  type Command,
  DomainEvent,
  feedbackPrompt,
  JudgedFinding,
  ReviewCheckout,
  ReviewSubject,
  type RiskSummary,
  Verdict,
} from "@polaris/protocol";
import { Predicate } from "effect";
import { patchTurn } from "../store/model.ts";
import { type CheckoutInput, decideCheckout } from "./checkout.ts";
import type { Decision, Deciding } from "./decider.ts";
import { REVIEW_DIRECTORY } from "./worktrees.ts";

type CommandOf<Tag extends Command["_tag"]> = Extract<Command, { _tag: Tag }>;

const sendFeedback = (d: Deciding, command: CommandOf<"SendFeedback">): Decision =>
  d.withSession(command.sessionId, (record) => {
    const prompt = feedbackPrompt(command.feedback);

    if (prompt.trim() === "") return d.reject("the feedback is empty");
    const turn = patchTurn(d.newTurn(record.session, prompt), { feedback: command.feedback });

    return d.lifecycle(record, { type: "turn.send", turn });
  });

const acceptTurns = (d: Deciding, command: CommandOf<"AcceptTurns">): Decision =>
  d.withSession(command.sessionId, (record) => {
    const turn =
      record.turns.find((t) => t.id === command.throughTurnId) ??
      (d.ctx.namedTurn?.id === command.throughTurnId ? d.ctx.namedTurn : undefined);

    if (turn === undefined || turn.sessionId !== command.sessionId) {
      return d.notFound("turn", command.throughTurnId);
    }

    return d.lifecycle(record, {
      type: "turns.accept",
      turnId: turn.id,
      index: turn.index,
      userTurnNumber: turn.userTurnNumber,
      status: turn.status,
      revertLaterTurns: command.revertLaterTurns,
      acceptedBy: d.ctx.deviceLabel,
    });
  });

const linkPullRequest = (d: Deciding, command: CommandOf<"LinkPullRequest">): Decision =>
  d.withSession(command.sessionId, () =>
    d.ok(
      DomainEvent.cases.SessionPullRequestLinked.make({
        sessionId: command.sessionId,
        pullRequest: command.pullRequest,
      })
    )
  );

const onCheckout = (d: Deciding, checkout: ReviewCheckout | undefined, input: CheckoutInput) => {
  const decision = decideCheckout(checkout, input);

  return decision.rejection === null ? d.ok(...decision.events) : d.reject(decision.rejection);
};

const withCheckout = (
  d: Deciding,
  checkoutId: ReviewCheckout["id"],
  f: (checkout: ReviewCheckout) => Decision
): Decision => {
  const checkout = d.model.reviewCheckouts.get(checkoutId);

  return checkout === undefined ? d.notFound("review checkout", checkoutId) : f(checkout);
};

/** Where a subject's checkout lives: `<worktreeRoot>/.review/pr-<n>` or `…/session-<id>`. */
const checkoutDirectory = (subject: ReviewSubject): string =>
  ReviewSubject.match(subject, {
    PullRequest: ({ pullRequest }) => `pr-${pullRequest.number}`,
    SessionTurns: ({ sessionId }) => `session-${sessionId}`,
  });

const openReviewCheckout = (d: Deciding, command: CommandOf<"OpenReviewCheckout">): Decision => {
  const workspace = d.model.workspaces.get(command.workspaceId);

  if (workspace === undefined) return d.notFound("workspace", command.workspaceId);

  if (!workspace.isGitRepo) return d.reject("a Review Checkout needs a git repository");
  const pullRequest = Predicate.isTagged(command.subject, "PullRequest");

  if (pullRequest && (command.head === null || command.base === null)) {
    return d.reject("a pull request's Review Checkout needs its head and base commits");
  }

  const path = join(workspace.worktreeRoot, REVIEW_DIRECTORY, checkoutDirectory(command.subject));

  for (const open of d.model.reviewCheckouts.values()) {
    if (open.path === path && open.id !== command.checkoutId) {
      return d.reject(`Review Checkout ${open.id} is already open there`);
    }
  }

  const checkout = new ReviewCheckout({
    id: command.checkoutId,
    workspaceId: workspace.id,
    subject: command.subject,
    path,
    state: "fetching",
    blocked: null,
    head: null,
    mergeBase: null,
    latestHead: command.head ?? "",
    latestBase: command.base ?? "",
    reviewedHead: null,
    reviewedMergeBase: null,
    openedAt: d.ctx.now,
    updatedAt: d.ctx.now,
  });

  return onCheckout(d, d.model.reviewCheckouts.get(command.checkoutId), {
    type: "checkout.open",
    checkout,
  });
};

/** The Finding a Verdict judges, from its summary (resolved before deciding). */
const recordVerdict = (
  d: Deciding,
  command: CommandOf<"RecordVerdict">,
  summary: RiskSummary | null
): Decision => {
  if (summary === null || summary.id !== command.summaryId) {
    return d.notFound("risk summary", command.summaryId);
  }

  const finding = summary.findings.find((f) => f.id === command.findingId);

  if (finding === undefined) return d.notFound("risk finding", command.findingId);

  if (command.thumb === "down" && command.reasons.length === 0 && command.text === null) {
    return d.reject("a thumbs-down needs a reason");
  }

  const verdict = new Verdict({
    id: command.verdictId,
    repo: summary.key.repo,
    summaryId: summary.id,
    findingId: finding.id,
    finding: new JudgedFinding({
      identity: finding.identity,
      source: finding.source,
      ruleId: finding.ruleId,
      path: finding.path,
      severity: finding.severity,
      title: finding.title,
    }),
    thumb: command.thumb,
    reasons: command.thumb === "up" ? [] : command.reasons,
    text: command.text,
    scope: command.scope,
    recordedBy: d.ctx.deviceLabel,
    recordedAt: d.ctx.now,
  });

  return d.ok(DomainEvent.cases.VerdictRecorded.make({ verdict }));
};

type ReviewCommand = CommandOf<
  | "SendFeedback"
  | "AcceptTurns"
  | "LinkPullRequest"
  | "OpenReviewCheckout"
  | "ReportReviewHead"
  | "UpdateReviewCheckout"
  | "RemoveReviewCheckout"
  | "RecordVerdict"
>;

export const reviewDeciders = (d: Deciding) =>
  ({
    SendFeedback: (c) => sendFeedback(d, c),
    AcceptTurns: (c) => acceptTurns(d, c),
    LinkPullRequest: (c) => linkPullRequest(d, c),
    OpenReviewCheckout: (c) => openReviewCheckout(d, c),
    ReportReviewHead: (c) =>
      withCheckout(d, c.checkoutId, (checkout) =>
        onCheckout(d, checkout, {
          type: "checkout.reportHead",
          head: c.head,
          base: c.base,
          at: d.ctx.now,
        })
      ),
    UpdateReviewCheckout: (c) =>
      withCheckout(d, c.checkoutId, (checkout) =>
        onCheckout(d, checkout, {
          type: "checkout.update",
          discardChanges: c.discardChanges,
          at: d.ctx.now,
        })
      ),
    RemoveReviewCheckout: (c) =>
      withCheckout(d, c.checkoutId, (checkout) =>
        onCheckout(d, checkout, { type: "checkout.remove", at: d.ctx.now })
      ),
    RecordVerdict: (c) => recordVerdict(d, c, d.ctx.judgedSummary),
  }) satisfies {
    readonly [K in ReviewCommand["_tag"]]: (command: CommandOf<K>) => Decision;
  };
