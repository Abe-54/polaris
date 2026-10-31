/**
 * Which pending approval ⌘⇧A answers: the card the user is in, else the lowest card on screen,
 * else the only one pending. With several pending and none shown, it answers none.
 */
import type { ApprovalRequest } from "@polaris/protocol";
import { useCallback } from "react";

const shown = new Map<string, Set<HTMLElement>>();

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

/** Whether a card of the approval is on screen now, so what it asks is in front of the user. */
export const isApprovalOnScreen = (
  requestId: string,
  visible: (e: HTMLElement) => boolean = onScreen
) => [...(shown.get(requestId) ?? [])].some((element) => visible(element));

export const onScreen = (element: HTMLElement) => {
  const rect = element.getBoundingClientRect();

  return rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
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
