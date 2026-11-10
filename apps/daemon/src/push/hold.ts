/**
 * Pushes held while the user is at a Desktop App (ENG-495, ENG-524). Only Needs You is held:
 * the Desktop App already showed finished Turns and notifications as banners. A request
 * answered or withdrawn there is dropped; the rest go out when presence ends. Pure.
 */
import type { DomainEvent, HostStreamItem } from "@polaris/protocol";
import { Match, Predicate } from "effect";
import type { Push } from "./plan.ts";

/** The most pushes held at once; past it the oldest go first. */
export const MAX_HELD = 200;

export type Held = ReadonlyArray<Push>;

const isNeed = ({ need }: Push) => need.requestId !== null || need.continues === true;

/** Holds the Needs You among `pushes`; the rest the Desktop App showed, so they're dropped. */
export const hold = (held: Held, pushes: ReadonlyArray<Push>): Held => {
  const needsYou = pushes.filter(isNeed);

  return needsYou.length === 0 ? held : [...held, ...needsYou].slice(-MAX_HELD);
};

const withoutRequest = (held: Held, requestId: string): Held =>
  held.filter(({ need }) => need.requestId !== requestId);

const settleEvent = (held: Held, event: DomainEvent): Held =>
  Match.value(event).pipe(
    Match.tags({
      ApprovalResolved: ({ requestId }) => withoutRequest(held, requestId),
      ApprovalWithdrawn: ({ requestId }) => withoutRequest(held, requestId),
      // A session waiting on Continue is handled once it leaves Needs You (a Turn, Archive).
      SessionStateChanged: ({ sessionId, state }) =>
        state === "needs-you"
          ? held
          : held.filter(({ need }) => need.continues !== true || need.sessionId !== sessionId),
    }),
    Match.orElse(() => held)
  );

/** Drops the held Needs You whose request this Host stream item shows answered or withdrawn. */
export const settleItem = (held: Held, item: HostStreamItem): Held =>
  held.length === 0 || !Predicate.isTagged(item, "Event")
    ? held
    : settleEvent(held, item.envelope.event);
