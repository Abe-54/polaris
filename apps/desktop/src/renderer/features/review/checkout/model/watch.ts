/**
 * Following every Review Checkout's pull request on GitHub (ENG-228): the Desktop App holds
 * the tokens, so it tells each Host's Daemon about new heads (`ReportReviewHead`) and asks it
 * to remove the checkouts of merged or closed pull requests (`RemoveReviewCheckout`). The
 * Daemon still refuses a removal while the checkout has edits or something runs in it.
 */
import type { ReviewCheckout } from "@polaris/protocol";
import { Predicate } from "effect";
import type { CheckoutStateView, CheckoutWatch, PullRef } from "../../../../../shared/github.ts";

/** A closed pull request can reopen, so its checkout waits this long after closing. */
export const CLOSED_GRACE_MS = 60 * 60 * 1000;

export interface HeldCheckout {
  readonly hostKey: string;
  readonly checkout: ReviewCheckout;
}

/** The watch key of a checkout: its Host and id. */
export const watchKey = (hostKey: string, checkout: Pick<ReviewCheckout, "id">) =>
  `${hostKey} ${checkout.id}`;

/** `owner/name#n`, lowercased: how pull requests are matched across GitHub and Hosts. */
export const pullName = (pull: PullRef) =>
  `${pull.repo.owner}/${pull.repo.name}#${pull.number}`.toLowerCase();

export const pullOf = (checkout: Pick<ReviewCheckout, "subject">): PullRef | null =>
  Predicate.isTagged(checkout.subject, "PullRequest")
    ? {
        repo: {
          owner: checkout.subject.pullRequest.repo.owner,
          name: checkout.subject.pullRequest.repo.name,
        },
        number: checkout.subject.pullRequest.number,
      }
    : null;

/** Every pull request checkout whose GitHub node id is known, to watch. */
export const watchList = (
  held: ReadonlyArray<HeldCheckout>,
  pullIds: Readonly<Record<string, string>>
): ReadonlyArray<CheckoutWatch> =>
  held.flatMap(({ hostKey, checkout }) => {
    const pull = pullOf(checkout);
    const pullId = pull === null ? undefined : pullIds[pullName(pull)];

    return pull === null || pullId === undefined
      ? []
      : [{ key: watchKey(hostKey, checkout), pull, pullId }];
  });

export type WatchAction =
  | {
      readonly kind: "remove";
      readonly hostKey: string;
      readonly checkout: ReviewCheckout;
      readonly reason: "merged" | "closed";
    }
  | {
      readonly kind: "report";
      readonly hostKey: string;
      readonly checkout: ReviewCheckout;
      readonly head: string;
      readonly base: string;
    };

/** What was last sent per watch key, so a quiet poll sends nothing again. */
export type Sent = ReadonlyMap<string, string>;

export const actionKey = (action: WatchAction) =>
  action.kind === "remove" ? `remove:${action.reason}` : `report:${action.head}`;

const closedLongEnough = (view: CheckoutStateView, now: number) => {
  const at = view.closedAt === null ? Number.NaN : Date.parse(view.closedAt);

  return Number.isNaN(at) || now - at >= CLOSED_GRACE_MS;
};

const decideOne = (
  view: CheckoutStateView,
  { hostKey, checkout }: HeldCheckout,
  now: number
): WatchAction | null => {
  if (checkout.state === "removing") return null;

  if (view.state === "merged") return { kind: "remove", hostKey, checkout, reason: "merged" };

  if (view.state === "closed") {
    return closedLongEnough(view, now)
      ? { kind: "remove", hostKey, checkout, reason: "closed" }
      : null;
  }

  if (view.state !== "open" || view.headRefOid === null) return null;

  if (view.headRefOid === checkout.latestHead) return null;

  return { kind: "report", hostKey, checkout, head: view.headRefOid, base: checkout.latestBase };
};

/** What GitHub's latest poll asks of the Hosts, minus what was already sent. */
export const decide = (
  views: ReadonlyArray<CheckoutStateView>,
  held: ReadonlyArray<HeldCheckout>,
  sent: Sent,
  now: number
): ReadonlyArray<WatchAction> => {
  const byKey = new Map(held.map((h) => [watchKey(h.hostKey, h.checkout), h]));

  return views.flatMap((view) => {
    const found = byKey.get(view.key);
    const action = found === undefined ? null : decideOne(view, found, now);

    return action === null || sent.get(view.key) === actionKey(action) ? [] : [action];
  });
};
