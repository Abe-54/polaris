/** Which capability a Client must announce to be sent an event (older Clients can't decode newer tags). */
import { type Capability, DomainEvent } from "@polaris/protocol";
import { Match, Predicate } from "effect";

/** Every capability `eventCapability` can ask for. */
export const gatingCapabilities: ReadonlyArray<Capability> = [
  "workspace.setup",
  "session.accept",
  "review.checkouts",
  "constellation",
  "host.resources",
  "session.background-tasks",
  "session.compaction",
  "session.notify",
  "session.pin",
  "session.limited",
  "approval.secret",
  "computer-use",
];

const needs = (capability: Capability) => (): Capability => capability;

/**
 * The capability a Client must have announced to be sent an event, or null
 * for events every Client decodes. An older Client can't decode newer tags.
 */
export const eventCapability = (event: DomainEvent): Capability | null =>
  DomainEvent.matchOrElse(
    event,
    {
      ConstellationStarted: needs("constellation"),
      ConstellationStateChanged: needs("constellation"),
      LeadChanged: needs("constellation"),
      LeadHandoverRequested: needs("constellation"),
      LeadHandoverCancelled: needs("constellation"),
      AttemptInterrupted: needs("constellation"),
      AttemptStale: needs("constellation"),
      AttemptFresh: needs("constellation"),
      WorkerInputDelivered: needs("constellation"),
      TaskDeclared: needs("constellation"),
      TaskEdited: needs("constellation"),
      TaskCanceled: needs("constellation"),
      TaskProposed: needs("constellation"),
      ProposalAccepted: needs("constellation"),
      ProposalDeclined: needs("constellation"),
      AttemptStarted: needs("constellation"),
      AttemptProgressed: needs("constellation"),
      AttemptClaimed: needs("constellation"),
      ClaimApproved: needs("constellation"),
      ClaimHandedUp: needs("constellation"),
      AttemptBlocked: needs("constellation"),
      AttemptUnblocked: needs("constellation"),
      AttemptNudged: needs("constellation"),
      AttemptAccepted: needs("constellation"),
      AttemptRejected: needs("constellation"),
      AttemptSettled: needs("constellation"),
      GatePromoted: needs("constellation"),
      NotificationQueued: needs("constellation"),
      LeadNotified: needs("constellation"),
      OperatorMessageSent: needs("constellation"),
      OperatorMessageResolved: needs("constellation"),
      PeerMessage: needs("constellation"),
      AttemptRecoveryContinued: needs("constellation"),
      ResourceDeclared: needs("host.resources"),
      ResourceRemoved: needs("host.resources"),
      ResourceLeaseCanceled: needs("host.resources"),
      ResourceLeaseQueued: needs("host.resources"),
      ResourceLeased: needs("host.resources"),
      ResourceReleased: needs("host.resources"),
      SessionBackgroundTasksChanged: needs("session.background-tasks"),
      SessionCompacted: needs("session.compaction"),
      SessionNotified: needs("session.notify"),
      SessionPinned: needs("session.pin"),
      SessionResumeAtResetChanged: needs("session.limited"),
      SessionSetupChanged: needs("workspace.setup"),
      TurnsAccepted: needs("session.accept"),
      TurnsReverted: needs("session.accept"),
      SessionPullRequestLinked: needs("session.accept"),
      ReviewCheckoutOpened: needs("review.checkouts"),
      ReviewCheckoutChanged: needs("review.checkouts"),
      ReviewCheckoutRemoved: needs("review.checkouts"),
      ApprovalRequested: ({ request }) =>
        Match.value(request.kind).pipe(
          Match.when("secret", (): Capability => "approval.secret"),
          Match.when("computer-use", (): Capability => "computer-use"),
          Match.orElse(() => null)
        ),
      ApprovalResolved: ({ decision }) =>
        Predicate.isTagged(decision, "Provided") ? "approval.secret" : null,
    },
    () => null
  );
