import {
  ConstellationEvent,
  type Task,
  type Attempt,
  type EventEnvelope,
  type TaskDefinition,
  type TaskId,
} from "@polaris/protocol";
import { Match } from "effect";
import type { SessionRecord } from "../store/model.ts";
import { graphEvent, type ConstellationRecord } from "../store/constellation.ts";
import { capacityBlocked, failureKindLabel } from "./failureKind.ts";
import { childTasks, isParent } from "./parents.ts";
import { activeAttempt, latestAttempt, projectTask } from "./projections.ts";
import { type HostSlots, phaseOf, phaseText, slotLine, workerLine } from "./slots.ts";
import { heldWait } from "./waiting.ts";
import { eventTask, statusScope, type StatusScope, type StatusView } from "./statusView.ts";

export const proposalDetails = (task: TaskDefinition): ReadonlyArray<string> => [
  `  Kind: ${task.kind} · parent: ${task.parent ?? "none"} · group: ${task.group ?? "none"}`,
  "  Brief:",
  ...task.brief.split("\n").map((line) => `    ${line}`),
  `  Dependencies: ${task.deps.join(", ") || "none"}`,
  `  Area: ${task.area.join(", ") || "none"}`,
  "  Criteria:",
  ...task.criteria.map((criterion) => `    ${criterion}`),
];

const prefix = (glob: string) => glob.split(/[?*[{]/, 1)[0] ?? "";

export const areaWarnings = (record: ConstellationRecord): ReadonlyArray<string> => {
  const working = record.graph.tasks.filter(
    (task) => latestAttempt(record.graph, task.id)?.state === "working"
  );

  const warnings: Array<string> = [];

  for (const [i, task] of working.entries())
    for (const peer of working.slice(i + 1)) {
      if (
        task.area.some((a) =>
          peer.area.some((b) => prefix(a).startsWith(prefix(b)) || prefix(b).startsWith(prefix(a)))
        )
      )
        warnings.push(`${task.id} and ${peer.id} may share an area`);
    }

  return warnings;
};

const reviewLines = (
  record: ConstellationRecord,
  attempt: Attempt,
  session?: SessionRecord,
  host?: HostSlots
): ReadonlyArray<string> => {
  const lines: Array<string> = [];

  if (attempt.approvedByUserAt !== null) lines.push("  Approved by the user · awaiting merge.");

  if (attempt.handedUpAt !== null)
    lines.push(
      `  Handed up to the user${attempt.handedUpReason === null ? "" : `: ${attempt.handedUpReason}`}`
    );

  if (
    attempt.state === "working" &&
    attempt.nudgedAt !== null &&
    heldWait(record, attempt, session, host?.now ?? Date.now()) === null &&
    session !== undefined &&
    (session.session.state === "idle" || session.session.state === "dormant") &&
    session.session.updatedAt > attempt.nudgedAt
  )
    lines.push("  Stopped without claiming · nudged once.");
  else if (attempt.state === "working" && session !== undefined)
    lines.push(`  ${workerLine(record, attempt, session, host)}`);

  if (attempt.state === "blocked")
    lines.push(
      `  blocked${attempt.blockedOn.length === 0 ? " awaiting the Lead" : ` by ${attempt.blockedOn.join(", ")}`}: ${attempt.blockedReason}`
    );

  return lines;
};

const failureLines = (attempt: Attempt): ReadonlyArray<string> =>
  attempt.failureKind === "capacity"
    ? [
        `  ${capacityBlocked(attempt.resetsAt)}${attempt.settleReason === null ? "" : `: ${attempt.settleReason.replace(/\s+/g, " ").trim()}`} · not redispatched automatically`,
      ]
    : attempt.state === "failed" || attempt.state === "lost"
      ? [
          `  ${attempt.state}${attempt.failureKind === null ? "" : ` · ${failureKindLabel(attempt.failureKind)}`}${attempt.settleReason === null ? "" : `: ${attempt.settleReason.replace(/\s+/g, " ").trim()}`}`,
        ]
      : [];

const rejectionLines = (record: ConstellationRecord, task: Task): ReadonlyArray<string> => {
  const lines: string[] = [];

  const previous = record.graph.attempts.findLast(
    (a) => a.taskId === task.id && a.state === "rejected"
  );

  if (previous !== undefined) {
    lines.push(
      `  Sent back attempt ${previous.id}${previous.rejectedBy === "user" ? " by the user" : ""}${previous.claim === null ? "" : ` · Claim ${previous.claim.head}`}`
    );

    if (previous.rejectionReason !== null) {
      const feedback = previous.rejectionReason.trim().split("\n");
      lines.push("  Review feedback:", ...feedback.slice(0, 3).map((line) => `    ${line}`));

      if (feedback.length > 3) lines.push("    …");
    }
  }

  return lines;
};

const taskLines = (
  record: ConstellationRecord,
  task: Task,
  sessions?: ReadonlyMap<Attempt["sessionId"], SessionRecord>,
  host?: HostSlots
): ReadonlyArray<string> => {
  const graph = record.graph;
  const lines: Array<string> = [];
  const projection = projectTask(record, task);
  const attempt = latestAttempt(graph, task.id);
  lines.push(
    `${task.id} · ${task.title} · ${task.kind} · ${projection.state} · task revision ${task.revision}${projection.blockedBy.length === 0 ? "" : ` · waiting on ${projection.blockedBy.join(", ")}`}`
  );

  if (attempt !== undefined) {
    lines.push(
      `  ${attempt.id} · attempt revision ${attempt.revision} · ${attempt.sessionId} · ${attempt.branch}${projection.stale ? " · host offline" : ""}`
    );

    lines.push(...reviewLines(record, attempt, sessions?.get(attempt.sessionId), host));
    lines.push(...failureLines(attempt));

    if (attempt.claim !== null && attempt.state === "review")
      lines.push(
        `  Claim ${attempt.claim.head} · ${attempt.claim.receipts.length} receipts · ${attempt.claim.notDone.length} not done${projection.branchFetched ? "" : " · branch not yet fetched"}: ${attempt.claim.summary}`
      );
  }

  lines.push(...rejectionLines(record, task));

  return lines;
};

const treeLines = (
  record: ConstellationRecord,
  scope: StatusScope | null,
  sessions?: ReadonlyMap<Attempt["sessionId"], SessionRecord>,
  host?: HostSlots
): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  const shown = (task: Task) => scope === null || scope.shown(task.id);

  const roots = record.graph.tasks.filter(
    (task) =>
      shown(task) &&
      (task.parent === null || !record.graph.tasks.some((t) => t.id === task.parent && shown(t)))
  );

  const groups = [...new Set(roots.map((task) => task.group))];

  const append = (task: Task, depth: number) => {
    lines.push(
      ...taskLines(record, task, sessions, host).map((line) => `${"  ".repeat(depth)}${line}`)
    );

    for (const child of childTasks(record.graph.tasks, task.id).filter(shown))
      append(child, depth + 1);
  };

  for (const group of groups) {
    if (group !== null) lines.push(group);

    for (const root of roots.filter((task) => task.group === group))
      append(root, group === null ? 0 : 1);
  }

  return lines;
};

const scopedAttempt = (record: ConstellationRecord, scope: StatusScope, attemptId: string) => {
  const task = record.graph.attempts.find((a) => a.id === attemptId)?.taskId;

  return task !== undefined && scope.inScope(task);
};

/** A stable, readable outline, computed only when requested. */
export const statusOutline = (
  record: ConstellationRecord,
  sessions?: ReadonlyMap<Attempt["sessionId"], SessionRecord>,
  host?: HostSlots,
  view: StatusView = {}
): string => {
  const { graph } = record;
  const scope = statusScope(record, view);
  const inScope = (attemptId: string) => scope === null || scopedAttempt(record, scope, attemptId);

  const lines = [
    `${graph.name} · ${graph.state} · revision ${graph.revision}`,
    `Lead: ${graph.leadSessionId}`,
  ];

  lines.push(...treeLines(record, scope, sessions, host));

  if (graph.tasks.length === 0) lines.push("No tasks yet.");

  // A worker writes the question: keep it on its own line of the Lead's status.
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

  for (const { attemptId, question } of graph.openQuestions.filter((q) => inScope(q.attemptId)))
    lines.push(
      `Question ${oneLine(question.id)} · ${attemptId} · to ${question.to}${question.blocking ? " · blocking" : ""}: ${oneLine(question.text)}`
    );

  for (const [id, proposal] of [...record.proposals].filter(([, p]) => inScope(p.by))) {
    lines.push(`Proposal ${id} · ${proposal.task.id} · by ${proposal.by}: ${proposal.task.title}`);
    lines.push(...proposalDetails(proposal.task));
  }

  if (record.handoverRequest !== null)
    lines.push(
      `Handover queued · ${record.handoverRequest.requestId} · waiting for the Turn boundary`
    );

  for (const message of record.messages.values())
    lines.push(`Message ${message.id} · ${message.authority} · in transit: ${message.text}`);
  lines.push(...areaWarnings(record).map((warning) => `Area: ${warning}`));

  const ready = graph.tasks
    .filter((task) => !isParent(graph, task.id) && projectTask(record, task).state === "ready")
    .map((task) => task.id);

  lines.push(`Ready: ${ready.length > 0 ? ready.join(", ") : "none"}`);
  const slots = host === undefined ? null : slotLine(host, graph.id);

  if (slots !== null) lines.push(slots);
  lines.push(`Lead updates queued: ${graph.pendingNotifications.length}`);

  if (
    graph.tasks.length > 0 &&
    graph.tasks.every((task) => task.canceled || projectTask(record, task).state === "done") &&
    !graph.attempts.some(activeAttempt)
  )
    lines.push("All tasks are done. The lead or user can complete the constellation.");

  return lines.join("\n");
};

const first = (text: string) => text.split("\n")[0]?.trim() ?? "";

/** One line per graph event, in the Lead's words; internal bookkeeping stays out. */
const eventLine = (record: ConstellationRecord, e: ConstellationEvent): string | null => {
  const task = (id: string) => record.graph.attempts.find((a) => a.id === id)?.taskId ?? id;

  return ConstellationEvent.match(e, {
    ConstellationStarted: () => "Constellation started.",
    ConstellationStateChanged: (x) => `Constellation ${x.state}.`,
    LeadHandoverRequested: (x) => `Handover requested by ${x.from}.`,
    LeadHandoverCancelled: (x) => `Handover cancelled: ${x.reason}.`,
    LeadChanged: (x) => `Lead changed to ${x.to}.`,
    TaskDeclared: (x) => `${x.task.id} declared · ${x.task.title}.`,
    TaskEdited: (x) => `${x.task.id} edited · deps ${x.task.deps.join(", ") || "none"}.`,
    TaskCanceled: (x) => `${x.taskId} canceled.`,
    TaskProposed: (x) => `${task(x.by)} proposed ${x.task.id} · ${x.task.title}.`,
    ProposalAccepted: (x) => `Proposal accepted: ${x.task.id}.`,
    ProposalDeclined: (x) => `Proposal declined: ${first(x.reason)}.`,
    AttemptStarted: (x) =>
      `${x.attempt.taskId}: ${x.attempt.id} started on ${x.attempt.sessionId} (${x.attempt.cause._tag}).`,
    AttemptProgressed: (x) => `${task(x.attemptId)}: progress · ${first(x.note)}.`,
    AttemptClaimed: (x) =>
      `${task(x.attemptId)}: claimed ${x.claim.head} · ${first(x.claim.summary)}.`,
    ClaimApproved: (x) => `${task(x.attemptId)}: approved by the user.`,
    ClaimHandedUp: (x) => `${task(x.attemptId)}: handed up to the user.`,
    AttemptBlocked: (x) =>
      `${task(x.attemptId)}: blocked${x.on.length === 0 ? " awaiting the Lead" : ` by ${x.on.join(", ")}`} · ${first(x.reason)}.`,
    AttemptUnblocked: (x) => `${task(x.attemptId)}: unblocked (${x.cause}).`,
    AttemptNudged: (x) => `${task(x.attemptId)}: nudged after a silent end.`,
    AttemptInterrupted: (x) => `${task(x.attemptId)}: Turn interrupted by a Daemon restart.`,
    AttemptStale: (x) => `${task(x.attemptId)}: Host offline.`,
    AttemptFresh: (x) => `${task(x.attemptId)}: Host back.`,
    AttemptAccepted: (x) => `${task(x.attemptId)}: accepted at ${x.mergedHead} (${x.evidence}).`,
    AttemptRejected: (x) =>
      `${task(x.attemptId)}: sent back${x.by === "user" ? " by the user" : ""} · ${first(x.reason)}.`,
    AttemptSettled: (x) =>
      `${task(x.attemptId)}: ${x.outcome}${x.failureKind === null ? "" : ` · ${failureKindLabel(x.failureKind)}`} · ${first(x.reason)}.`,
    GatePromoted: (x) => `Gate ${x.taskId} is ready: every dependency accepted.`,
    NotificationQueued: () => null,
    LeadNotified: (x) =>
      `Digest ${x.steered ? "steered into your Turn" : "delivered"} · ${x.items.length} item(s)${x.audit === null ? "" : " · stall audit"}.`,
    OperatorMessageSent: (x) =>
      `Message ${x.id} to ${Match.value(x.target).pipe(
        Match.tag("Lead", () => "you"),
        Match.tag("All", () => "all workers"),
        Match.tag("Worker", (t) => task(t.attemptId)),
        Match.exhaustive
      )} · ${first(x.text)}.`,
    WorkerInputDelivered: () => null,
    OperatorMessageResolved: () => null,
    PeerMessage: (x) => `${task(x.from)} → ${task(x.to)}: ${first(x.text)}.`,
    AttemptRecoveryContinued: (x) => `${task(x.attemptId)}: continued after a Daemon restart.`,
  });
};

/** What changed after a graph revision, then where things stand; for a Lead that already knows the rest. */
export const statusSince = (
  record: ConstellationRecord,
  events: ReadonlyArray<EventEnvelope>,
  since: number,
  sessions?: ReadonlyMap<Attempt["sessionId"], SessionRecord>,
  host?: HostSlots,
  view: StatusView = {}
): string => {
  const { graph } = record;
  const scope = statusScope(record, view);

  const about = (id: TaskId | null) =>
    scope === null || view.task === undefined || (id !== null && scope.inScope(id));

  const changes = events.flatMap((envelope) => {
    const event = graphEvent(envelope.event);

    if (event === null || event.revision <= since || !about(eventTask(record, event))) return [];
    const text = eventLine(record, event);

    return text === null ? [] : [`${event.revision} · ${envelope.occurredAt} · ${text}`];
  });

  const ready = graph.tasks
    .filter(
      (task) =>
        about(task.id) && !isParent(graph, task.id) && projectTask(record, task).state === "ready"
    )
    .map((task) => task.id);

  // The same phase the Desktop App shows: stalled, idle, starting, waiting for a slot.
  const notWorking = graph.attempts.flatMap((a) => {
    const session = sessions?.get(a.sessionId);

    if (a.state !== "working" || session === undefined || !about(a.taskId)) return [];
    const phase = phaseOf(record, a, session, host);

    return phase.kind === "working" ? [] : [`${a.taskId} (${phaseText(phase, host?.now ?? null)})`];
  });

  return [
    `${graph.name} · ${graph.state} · revision ${graph.revision} · changes since revision ${since}: ${changes.length}`,
    ...(changes.length === 0 ? ["Nothing changed."] : changes),
    `In review: ${
      graph.attempts
        .filter((a) => a.state === "review" && about(a.taskId))
        .map((a) => a.taskId)
        .join(", ") || "none"
    }`,
    `Ready: ${ready.length > 0 ? ready.join(", ") : "none"}`,
    ...(notWorking.length === 0 ? [] : [`Not working: ${notWorking.join(", ")}`]),
    ...(host === undefined ? [] : [slotLine(host, graph.id)].filter((line) => line !== null)),
    `Lead updates queued: ${graph.pendingNotifications.length}`,
  ].join("\n");
};
