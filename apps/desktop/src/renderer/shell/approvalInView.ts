/**
 * Which pending approval ⌘⇧A answers: the card the user is in, else the lowest card on screen,
 * else the only one pending. With several pending and none shown, it answers none.
 */
import type { ApprovalRequest } from "@polaris/protocol";
import { useCallback } from "react";

const shown = new Map<string, Set<HTMLElement>>();

/** Marks the scroller cards sit in (the conversation), so "on screen" means inside it. */
export const APPROVAL_VIEWPORT = "data-approval-viewport";

/** Asks the conversation around a card to release the end and bring the card's row to the top. */
export const REVEAL_APPROVAL = "polaris:reveal-approval";

/** Marks a part of a write's card that must be fully in view before it runs from elsewhere. */
export const APPROVAL_PART = "data-approval-part";

/** A ref for an approval's card: while mounted, the card can be the one in view. */
export const useShownApproval = (requestId: string) =>
  useCallback(
    (element: HTMLElement | null) => {
      if (element === null) return undefined;
      const cards = shown.get(requestId) ?? new Set();

      cards.add(element);
      shown.set(requestId, cards);

      return () => {
        cards.delete(element);

        if (cards.size === 0) shown.delete(requestId);
      };
    },
    [requestId]
  );

/** The window, narrowed to the scroller the element sits in: what the user can see of it. */
const viewportOf = (element: HTMLElement) => {
  const scroller = element.closest(`[${APPROVAL_VIEWPORT}]`)?.getBoundingClientRect();
  const top = Math.max(0, scroller?.top ?? 0);
  const bottom = Math.min(window.innerHeight, scroller?.bottom ?? window.innerHeight);

  return { top, bottom };
};

/** Any of the card inside its viewport: it can be the one ⌘⇧A means. */
export const onScreen = (element: HTMLElement) => {
  const rect = element.getBoundingClientRect();
  const view = viewportOf(element);

  return rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom;
};

// Sub-pixel layout can put a fully shown edge a fraction outside.
const SLACK = 1;

const fullyShown = (part: Element, view: { top: number; bottom: number }) => {
  const rect = part.getBoundingClientRect();

  return rect.height > 0 && rect.top >= view.top - SLACK && rect.bottom <= view.bottom + SLACK;
};

/**
 * A write's card is in view when its statement (SQL through the dry run's kicker) and its Run row
 * are wholly inside the conversation's viewport; a card without parts must be wholly inside.
 */
export const writeInView = (card: HTMLElement) => {
  const view = viewportOf(card);
  const parts = [...card.querySelectorAll(`[${APPROVAL_PART}]`)];

  return (parts.length === 0 ? [card] : parts).every((part) => fullyShown(part, view));
};

/** Whether a card of the approval is in front of the user now, so what it asks has been seen. */
export const isApprovalOnScreen = (
  requestId: string,
  visible: (e: HTMLElement) => boolean = writeInView
) => [...(shown.get(requestId) ?? [])].some((element) => visible(element));

/** Brings a mounted card's top into view and focuses it, so ⌘↵ there runs it; false if none. */
export const revealApproval = (requestId: string) => {
  const cards = [...(shown.get(requestId) ?? [])];
  const card = cards.find((c) => c.hasAttribute("tabindex")) ?? cards[0];

  if (card === undefined) return false;

  const handled = !card.dispatchEvent(
    new Event(REVEAL_APPROVAL, { bubbles: true, cancelable: true })
  );

  if (!handled) card.scrollIntoView?.({ block: "start" });
  card.focus({ preventScroll: true });

  return true;
};

export const approvalInView = (
  pending: ReadonlyArray<ApprovalRequest>,
  visible: (element: HTMLElement) => boolean = onScreen
): ApprovalRequest | null => {
  // A Secret Request is answered only in its card, never approved or denied from a shortcut.
  const answerable = pending.filter((r) => r.kind !== "secret");

  const cards = answerable.flatMap((request) =>
    [...(shown.get(request.id) ?? [])].map((element) => ({ request, element }))
  );

  const focus = document.activeElement;
  const focused = cards.find(({ element }) => focus !== null && element.contains(focus));

  if (focused !== undefined) return focused.request;
  let lowest: { request: ApprovalRequest; top: number } | null = null;

  for (const { request, element } of cards) {
    const top = element.getBoundingClientRect().top;

    if (visible(element) && (lowest === null || top > lowest.top)) lowest = { request, top };
  }

  if (lowest !== null) return lowest.request;

  return answerable.length === 1 ? (answerable[0] ?? null) : null;
};
