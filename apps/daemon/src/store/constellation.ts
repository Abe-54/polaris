import {
  Attempt,
  type AttemptId,
  Constellation,
  ConstellationEvent,
  type ConstellationId,
  ConstellationDigest,
  ConstellationHandover,
  type ConstellationNotification,
  type ConstellationQuestion,
  PendingOperatorMessage,
  type DomainEvent,
  liveQuestions,
  OpenQuestion,
  type TaskDefinition,
  type SessionId,
  type TaskId,
  type TurnId,
  Task,
} from "@polaris/protocol";
import { attemptData, graphData, taskData } from "../constellation/data.ts";
import { projectTasks } from "../constellation/projections.ts";
import { Predicate } from "effect";

/** A wait a worker declared with the `wait` tool, folded with when it arrived (ENG-742). */
export interface DeclaredWait {
  readonly on: string;
  readonly until: string;
  readonly at: string;
}

export interface GraphQuestion {
  readonly attemptId: AttemptId;
  readonly question: ConstellationQuestion;
  readonly answer: string | null;
}

export interface ConstellationRecord {
  readonly graph: Constellation;
  readonly promoted: ReadonlySet<TaskId>;
  readonly proposals: ReadonlyMap<
    string,
    { readonly by: AttemptId; readonly task: TaskDefinition }
  >;
  readonly questions: ReadonlyMap<string, GraphQuestion>;
  readonly messages: ReadonlyMap<
    string,
    Extract<ConstellationEvent, { _tag: "OperatorMessageSent" }>
  >;
  readonly sentMessages: ConstellationRecord["messages"];
  readonly messageTargets: ReadonlyMap<string, ReadonlyArray<SessionId>>;
  readonly handoverRequest: Extract<ConstellationEvent, { _tag: "LeadHandoverRequested" }> | null;
  readonly peers: ReadonlyMap<string, Extract<ConstellationEvent, { _tag: "PeerMessage" }>>;
  readonly inputDeliveries: ReadonlySet<string>;
  readonly blockRevisions: ReadonlyMap<AttemptId, number>;
  readonly stale: ReadonlyMap<AttemptId, string>;
  readonly delivered: ReadonlySet<string>;
  readonly interruptions: ReadonlyMap<
    AttemptId,
    Extract<ConstellationEvent, { _tag: "AttemptInterrupted" }>
  >;
  readonly handoverStopped: ReadonlySet<AttemptId>;
  readonly recoveries: ReadonlySet<string>;
  readonly progress: ReadonlyMap<
    AttemptId,
    Extract<ConstellationEvent, { _tag: "AttemptProgressed" }>
  >;
  /** Each Attempt's latest declared wait; `constellation/waiting.ts` decides whether it holds. */
  readonly waits: ReadonlyMap<AttemptId, DeclaredWait>;
  /** When each proposal, progress note and operator message arrived, by `kindKey`. */
  readonly stamps: ReadonlyMap<string, string>;
  /** Every notification queued, so a digest can carry its items after delivery. */
  readonly notifications: ReadonlyMap<string, ConstellationNotification>;
  readonly digests: ReadonlyArray<ConstellationDigest>;
  /** Digests steered into a working Lead Turn, by that Turn's id. */
  readonly steeredDigests: ReadonlySet<TurnId>;
  /** The key of the last stall audit the Lead received; the same stalled state is noted once. */
  readonly lastAudit: string | null;
  /** Attempts a stall audit named as holding a slot with no first Turn; each is named once. */
  readonly slotStalls: ReadonlySet<AttemptId>;
  readonly handovers: ReadonlyArray<ConstellationHandover>;
}

/** The key a stamp is kept under: `proposal`, `progress` or `message`, then the id. */
export const stampKey = (kind: "proposal" | "progress" | "message", id: string) => `${kind}:${id}`;

const stamped = (record: ConstellationRecord, key: string, at: string) =>
  new Map([...record.stamps, [key, at]]);

export const constellationOf = (event: DomainEvent): ConstellationId | null =>
  "constellationId" in event ? event.constellationId : null;

export const graphEvent = (event: DomainEvent): ConstellationEvent | null => {
  if (!("constellationId" in event)) return null;

  return event;
};

/** What the switch looked like: C9's structured part, kept with the handover. */
const handoverOf = (
  record: ConstellationRecord,
  e: Extract<ConstellationEvent, { _tag: "LeadChanged" }>,
  at: string
) =>
  new ConstellationHandover({
    from: e.from,
    to: e.to,
    summary: e.summary,
    revision: e.revision,
    at,
    projections: projectTasks(record),
    inFlight: record.graph.attempts.flatMap((a) =>
      a.state === "working" || a.state === "blocked" || a.state === "review" ? [a.id] : []
    ),
    questions: [...record.notifications.values()].filter(
      ({ item }) =>
        Predicate.isTagged(item, "Question") &&
        record.graph.openQuestions.some(
          (q) => q.attemptId === item.attemptId && q.question.id === item.question.id
        )
    ),
    undelivered: [...record.messages.values()].map((m) => pendingMessage(record, m)),
  });

/** An unresolved operator message with when it was sent. */
export const pendingMessage = (
  record: ConstellationRecord,
  m: Extract<ConstellationEvent, { _tag: "OperatorMessageSent" }>
) =>
  new PendingOperatorMessage({
    id: m.id,
    authority: m.authority,
    target: m.target,
    text: m.text,
    at: record.stamps.get(stampKey("message", m.id)) ?? record.graph.updatedAt,
  });

export const inputDeliveryKey = (id: string, sessionId: SessionId) =>
  JSON.stringify([id, sessionId]);

export const peerMessageId = (e: Extract<ConstellationEvent, { _tag: "PeerMessage" }>) =>
  `${e.constellationId}:${e.revision}:peer`;

export const questionKey = (attemptId: AttemptId, id: string) => JSON.stringify([attemptId, id]);

const replace = <A extends { readonly id: string }>(items: ReadonlyArray<A>, next: A) =>
  items.some((item) => item.id === next.id)
    ? items.map((item) => (item.id === next.id ? next : item))
    : [...items, next];

const patchAttempt = (
  record: ConstellationRecord,
  event: { readonly attemptId: AttemptId; readonly attemptRevision: number },
  patch: Partial<typeof Attempt.Type>
) => {
  const current = record.graph.attempts.find((a) => a.id === event.attemptId);

  return current === undefined
    ? record.graph.attempts
    : replace(
        record.graph.attempts,
        new Attempt({ ...attemptData(current), ...patch, revision: event.attemptRevision })
      );
};

/** The head an in-review Claim had when this Claim amends it. */
const amendedHead = (record: ConstellationRecord, id: AttemptId) => {
  const current = record.graph.attempts.find((a) => a.id === id);

  return current?.state === "review" ? (current.claim?.head ?? null) : null;
};

const started = (graph: Constellation): ConstellationRecord => ({
  graph,
  promoted: new Set(),
  proposals: new Map(),
  questions: new Map(),
  messages: new Map(),
  sentMessages: new Map(),
  messageTargets: new Map(),
  handoverRequest: null,
  peers: new Map(),
  inputDeliveries: new Set(),
  blockRevisions: new Map(),
  stale: new Map(),
  delivered: new Set(),
  recoveries: new Set(),
  interruptions: new Map(),
  handoverStopped: new Set(),
  progress: new Map(),
  waits: new Map(),
  stamps: new Map(),
  notifications: new Map(),
  digests: [],
  steeredDigests: new Set(),
  lastAudit: null,
  slotStalls: new Set(),
  handovers: [],
});

/** Fold durable graph and delivery metadata; no lifecycle or readiness is inferred here. */
export const foldConstellation = (
  record: ConstellationRecord | undefined,
  event: ConstellationEvent,
  at: string
): ConstellationRecord | undefined => {
  if (Predicate.isTagged(event, "ConstellationStarted")) return started(event.constellation);

  if (record === undefined) return undefined;
  let next = record;

  let graph = new Constellation({
    ...graphData(record.graph),
    revision: event.revision,
    updatedAt: at,
  });

  ConstellationEvent.match(event, {
    ConstellationStarted: () => {},
    ConstellationStateChanged: (e) => {
      graph = new Constellation({ ...graphData(graph), state: e.state });
    },
    LeadHandoverRequested: (e) => {
      next = { ...next, handoverRequest: e };
    },
    LeadHandoverCancelled: (e) => {
      if (next.handoverRequest?.requestId === e.requestId)
        next = { ...next, handoverRequest: null };
    },
    LeadChanged: (e) => {
      next = { ...next, handoverRequest: null };
      graph = new Constellation({ ...graphData(graph), leadSessionId: e.to });
      next = { ...next, handovers: [...next.handovers, handoverOf(record, e, at)] };
    },
    TaskDeclared: (e) => {
      graph = new Constellation({ ...graphData(graph), tasks: replace(graph.tasks, e.task) });
    },
    TaskEdited: (e) => {
      graph = new Constellation({ ...graphData(graph), tasks: replace(graph.tasks, e.task) });
    },
    TaskCanceled: (e) => {
      graph = new Constellation({
        ...graphData(graph),
        tasks: graph.tasks.map((t) =>
          t.id === e.taskId
            ? new Task({ ...taskData(t), canceled: true, revision: e.taskRevision })
            : t
        ),
        attempts: graph.attempts.map((a) =>
          a.state === "blocked"
            ? new Attempt({
                ...attemptData(a),
                blockedOn: a.blockedOn.filter((id) => id !== e.taskId),
              })
            : a
        ),
      });
    },
    TaskProposed: (e) => {
      next = {
        ...next,
        proposals: new Map([...next.proposals, [e.proposalId, { by: e.by, task: e.task }]]),
        stamps: stamped(next, stampKey("proposal", e.proposalId), at),
      };
    },
    ProposalAccepted: (e) => {
      const proposals = new Map(next.proposals);
      proposals.delete(e.proposalId);
      next = { ...next, proposals };
      graph = new Constellation({ ...graphData(graph), tasks: replace(graph.tasks, e.task) });
    },
    ProposalDeclined: (e) => {
      const proposals = new Map(next.proposals);
      proposals.delete(e.proposalId);
      next = { ...next, proposals };
    },
    AttemptStarted: (e) => {
      graph = new Constellation({
        ...graphData(graph),
        attempts: replace(graph.attempts, e.attempt),
      });
    },
    AttemptProgressed: (e) => {
      graph = new Constellation({ ...graphData(graph), attempts: patchAttempt(next, e, {}) });
      next = {
        ...next,
        progress: new Map([...next.progress, [e.attemptId, e]]),
        stamps: stamped(next, stampKey("progress", e.attemptId), at),
        waits:
          e.waiting == null
            ? next.waits
            : new Map([...next.waits, [e.attemptId, { ...e.waiting, at }]]),
      };
    },
    AttemptClaimed: (e) => {
      graph = new Constellation({
        ...graphData(graph),
        attempts: patchAttempt(next, e, {
          state: "review",
          claim: e.claim,
          claimedAt: at,
          claimRevision: e.attemptRevision,
          previousClaimHead: amendedHead(next, e.attemptId),
          approvedByUserAt: null,
          handedUpAt: null,
          handedUpReason: null,
          nudgedAt: null,
        }),
      });
    },
    ClaimApproved: (e) => {
      graph = new Constellation({
        ...graphData(graph),
        attempts: patchAttempt(next, e, { approvedByUserAt: e.at }),
      });
    },
    ClaimHandedUp: (e) => {
      graph = new Constellation({
        ...graphData(graph),
        attempts: patchAttempt(next, e, { handedUpAt: e.at, handedUpReason: e.reason }),
      });
    },
    AttemptBlocked: (e) => {
      next = {
        ...next,
        blockRevisions: new Map([...next.blockRevisions, [e.attemptId, e.revision]]),
      };
      graph = new Constellation({
        ...graphData(graph),
        attempts: patchAttempt(next, e, {
          state: "blocked",
          blockedOn: e.on,
          blockedReason: e.reason,
          blockedAt: e.at,
        }),
      });
    },
    AttemptUnblocked: (e) => {
      graph = new Constellation({
        ...graphData(graph),
        attempts: patchAttempt(next, e, {
          state: "working",
          blockedOn: [],
          blockedReason: null,
          blockedAt: null,
          nudgedAt: null,
        }),
      });
    },
    AttemptNudged: (e) => {
      graph = new Constellation({
        ...graphData(graph),
        attempts: patchAttempt(next, e, { nudgedAt: e.at }),
      });
    },
    AttemptInterrupted: (e) => {
      next = { ...next, interruptions: new Map([...next.interruptions, [e.attemptId, e]]) };
    },
    AttemptStale: (e) => {
      next = { ...next, stale: new Map([...next.stale, [e.attemptId, e.at]]) };
    },
    AttemptFresh: (e) => {
      const stale = new Map(next.stale);
      stale.delete(e.attemptId);
      next = { ...next, stale };
    },
    AttemptAccepted: (e) => {
      graph = new Constellation({
        ...graphData(graph),
        attempts: patchAttempt(next, e, {
          state: "accepted",
          mergedHead: e.mergedHead,
          receipts: e.receipts,
          evidence: e.evidence,
          endedAt: at,
        }),
      });
    },
    AttemptRejected: (e) => {
      graph = new Constellation({
        ...graphData(graph),
        attempts: patchAttempt(next, e, {
          state: "rejected",
          rejectionReason: e.reason,
          rejectedBy: e.by ?? null,
          endedAt: at,
        }),
      });
    },
    AttemptSettled: (e) => {
      if (e.reason === "stopped by handover")
        next = { ...next, handoverStopped: new Set([...next.handoverStopped, e.attemptId]) };
      graph = new Constellation({
        ...graphData(graph),
        attempts: patchAttempt(next, e, {
          state: e.outcome,
          settleReason: e.reason,
          failureKind: e.failureKind,
          resetsAt: e.resetsAt,
          endedAt: at,
        }),
      });
    },
    GatePromoted: (e) => {
      next = { ...next, promoted: new Set([...next.promoted, e.taskId]) };
      graph = new Constellation({
        ...graphData(graph),
        tasks: graph.tasks.map((t) =>
          t.id === e.taskId
            ? new Task({ ...taskData(t), canceled: t.canceled, revision: e.taskRevision })
            : t
        ),
      });
    },
    NotificationQueued: (e) => {
      graph = new Constellation({
        ...graphData(graph),
        pendingNotifications: [...graph.pendingNotifications, e.notification],
      });
      next = {
        ...next,
        notifications: new Map([...next.notifications, [e.notification.id, e.notification]]),
      };

      if (Predicate.isTagged(e.notification.item, "Question")) {
        const { attemptId, question } = e.notification.item;
        graph = new Constellation({
          ...graphData(graph),
          openQuestions: [
            ...graph.openQuestions,
            new OpenQuestion({ attemptId, question, askedAt: e.notification.queuedAt }),
          ],
        });
        next = {
          ...next,
          questions: new Map([
            ...next.questions,
            [questionKey(attemptId, question.id), { attemptId, question, answer: null }],
          ]),
        };
      }
    },
    LeadNotified: (e) => {
      graph = new Constellation({
        ...graphData(graph),
        pendingNotifications: graph.pendingNotifications.filter((n) => !e.items.includes(n.id)),
      });
      next = {
        ...next,
        delivered: new Set([...next.delivered, ...e.items]),
        steeredDigests: e.steered
          ? new Set([...next.steeredDigests, e.turnId])
          : next.steeredDigests,
        lastAudit: e.audit?.key ?? next.lastAudit,
        slotStalls:
          (e.audit?.slots ?? []).length === 0
            ? next.slotStalls
            : new Set([...next.slotStalls, ...(e.audit?.slots ?? [])]),
        digests: [
          ...next.digests,
          new ConstellationDigest({
            turnId: e.turnId,
            steered: e.steered,
            leadSessionId: e.leadSessionId,
            revision: e.revision,
            at,
            items: e.items.flatMap((id) => {
              const n = next.notifications.get(id);

              return n === undefined ? [] : [n];
            }),
          }),
        ],
      };
    },
    OperatorMessageSent: (e) => {
      const recipients = graph.attempts
        .filter(
          (a) =>
            (Predicate.isTagged(e.target, "Worker") && a.id === e.target.attemptId) ||
            (Predicate.isTagged(e.target, "All") &&
              (a.state === "working" || a.state === "blocked" || a.state === "review"))
        )
        .map((a) => a.sessionId);

      next = { ...next, messageTargets: new Map([...next.messageTargets, [e.id, recipients]]) };
      next = {
        ...next,
        messages: new Map([...next.messages, [e.id, e]]),
        sentMessages: new Map([...next.sentMessages, [e.id, e]]),
        stamps: stamped(next, stampKey("message", e.id), at),
      };

      if (e.questionId !== null && Predicate.isTagged(e.target, "Worker")) {
        const { attemptId } = e.target;
        const key = questionKey(attemptId, e.questionId);
        const question = next.questions.get(key);
        graph = new Constellation({
          ...graphData(graph),
          openQuestions: graph.openQuestions.filter(
            (q) => q.attemptId !== attemptId || q.question.id !== e.questionId
          ),
        });

        if (question !== undefined)
          next = {
            ...next,
            questions: new Map([...next.questions, [key, { ...question, answer: e.text }]]),
          };
      }
    },
    OperatorMessageResolved: (e) => {
      const messages = new Map(next.messages);
      messages.delete(e.id);
      next = { ...next, messages };
    },
    PeerMessage: (e) => {
      next = { ...next, peers: new Map([...next.peers, [peerMessageId(e), e]]) };
    },
    WorkerInputDelivered: (e) => {
      const peers = new Map(next.peers);
      const peer = peers.get(e.id);

      if (
        peer !== undefined &&
        graph.attempts.some((a) => a.id === peer.to && a.sessionId === e.sessionId)
      )
        peers.delete(e.id);
      next = {
        ...next,
        peers,
        inputDeliveries: new Set([...next.inputDeliveries, inputDeliveryKey(e.id, e.sessionId)]),
      };
    },
    AttemptRecoveryContinued: (e) => {
      next = {
        ...next,
        recoveries: new Set([...next.recoveries, JSON.stringify([e.attemptId, e.interruptionId])]),
      };
      graph = new Constellation({ ...graphData(graph), attempts: patchAttempt(next, e, {}) });
    },
  });

  const open = liveQuestions(graph.openQuestions, graph.attempts);

  if (open.length !== graph.openQuestions.length)
    graph = new Constellation({ ...graphData(graph), openQuestions: open });

  return { ...next, graph };
};
