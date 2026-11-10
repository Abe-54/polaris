/**
 * What a Reviewer's or walkthrough's own session reviews, for its notification (ENG-378): the
 * change it names, the Review a click opens and, for the Reviewer, its findings. A pull
 * request's runs work in its Review Checkout; an Agent Session's in its Workspace, titled
 * "Reviewer · <session title>" (or "Walkthrough · …").
 */
import type { AgentSession, ReviewSubject } from "@polaris/protocol";
import { Predicate } from "effect";
import { type PullListView, type PullRowView, repoOfRow } from "../../../../shared/github.ts";
import type { NeedsYouReview, ReviewTarget, UserTurn } from "../../../../shared/needsYou.ts";
import type { HostModel } from "../../../store/hostModel.ts";
import { pullName, pullOf } from "../../review/checkout/model/watch.ts";
import type { Summary } from "../../risk/model/summary.ts";
import { isReviewSession } from "../../sessions/model/sections.ts";

/** A Risk Summary the renderer holds (`riskStore`), with its Host. */
export interface HeldSummary {
  readonly hostKey: string;
  readonly summary: Summary;
}

/** A pull request list row, as far as a notification reads it. */
export type PullRow = Pick<PullRowView, "id" | "number" | "title" | "repo" | "host">;

/** Every row of the pull request list, for the titles Review notifications name. */
export const pullRows = (list: PullListView | null): ReadonlyArray<PullRow> =>
  list === null ? [] : [...list.requested, ...list.mine, ...list.other, ...(list.reviewed ?? [])];

export interface ReviewInput {
  readonly hostKey: string;
  readonly model: HostModel;
  readonly session: AgentSession;
  readonly userTurn: Pick<UserTurn, "startedAt"> | null;
  readonly pulls: ReadonlyArray<PullRow>;
  readonly summaries: ReadonlyArray<HeldSummary>;
}

type Kind = NeedsYouReview["kind"];

const PREFIX: Readonly<Record<Kind, string>> = {
  reviewer: "Reviewer · ",
  walkthrough: "Walkthrough · ",
};

const NEW_COMMITS = " · new commits";

const kindOf = (session: AgentSession): Kind =>
  session.origin ?? (session.title.startsWith(PREFIX.walkthrough) ? "walkthrough" : "reviewer");

/** The reviewed change's title, as the Daemon wrote it after the prefix. */
const reviewedTitle = (session: AgentSession, kind: Kind) => {
  const title = session.title.startsWith(PREFIX[kind])
    ? session.title.slice(PREFIX[kind].length)
    : session.title;

  return title.endsWith(NEW_COMMITS) ? title.slice(0, -NEW_COMMITS.length) : title;
};

interface Found {
  readonly change: string;
  readonly target: ReviewTarget;
}

const pullReview = (subject: ReviewSubject, pulls: ReadonlyArray<PullRow>): Found | null => {
  const pull = pullOf({ subject });

  if (pull === null) return null;

  const row = pulls.find(
    (r) => pullName({ repo: repoOfRow(r), number: r.number }) === pullName(pull)
  );

  return {
    change: row?.title ?? `${pull.repo.owner}/${pull.repo.name} #${pull.number}`,
    target: { kind: "pull", repo: pull.repo, number: pull.number, pullId: row?.id ?? null },
  };
};

const sessionReview = (hostKey: string, model: HostModel, sessionId: string): Found | null => {
  const entry = model.sessions.get(sessionId);

  return entry === undefined
    ? null
    : { change: entry.session.title, target: { kind: "session", hostKey, sessionId } };
};

/** The Agent Session in the same Workspace whose title the run carries; the newest wins. */
const sessionByTitle = (model: HostModel, session: AgentSession, title: string) =>
  [...model.sessions.values()]
    .filter(
      ({ session: s }) =>
        s.workspaceId === session.workspaceId && s.title === title && !isReviewSession(s)
    )
    .sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt))[0]?.session.id;

const bySubject = (input: ReviewInput, subject: ReviewSubject): Found | null =>
  Predicate.isTagged(subject, "SessionTurns")
    ? sessionReview(input.hostKey, input.model, subject.sessionId)
    : pullReview(subject, input.pulls);

const foundOf = (input: ReviewInput, kind: Kind): Found | null => {
  const { hostKey, model, session } = input;

  // A Daemon with `session.review-subject` names it; older ones leave the cwd and title.
  if (session.reviewSubject != null) return bySubject(input, session.reviewSubject);
  const checkout = [...model.reviewCheckouts.values()].find((c) => c.path === session.cwd);

  if (checkout !== undefined) return bySubject(input, checkout.subject);
  const reviewed = sessionByTitle(model, session, reviewedTitle(session, kind));

  return reviewed === undefined ? null : sessionReview(hostKey, model, reviewed);
};

/** This run's finished Risk Summary: the Reviewer's session, ended after its Turn began. */
const findingsOf = ({ hostKey, session, userTurn, summaries }: ReviewInput) => {
  const held = summaries.find(
    ({ hostKey: key, summary }) =>
      key === hostKey &&
      summary.reviewer?.sessionId === session.id &&
      summary.status === "completed" &&
      summary.endedAt !== null &&
      userTurn !== null &&
      Date.parse(summary.endedAt) >= Date.parse(userTurn.startedAt)
  );

  if (held === undefined) return null;
  const open = held.summary.findings.filter((f) => f.status === "open");

  return { open: open.length, critical: open.filter((f) => f.severity === "critical").length };
};

/** A Reviewer's or walkthrough's session as its Review; undefined for any other session. */
export const reviewOf = (input: ReviewInput): NeedsYouReview | undefined => {
  if (!isReviewSession(input.session)) return undefined;
  const kind = kindOf(input.session);
  const found = foundOf(input, kind);

  return {
    kind,
    change: found?.change ?? reviewedTitle(input.session, kind),
    target: found?.target ?? null,
    findings: kind === "reviewer" ? findingsOf(input) : null,
  };
};
