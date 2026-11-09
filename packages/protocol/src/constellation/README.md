# Constellation contract

Public exports are available from `@polaris/protocol` and this module's `index.ts`.
The contract implements `docs/specs/constellations-v1.md` §§2–3, 7–9. The graph
is folded on the Lead's Host; these schemas do not implement its decider.

| File | Contract |
| --- | --- |
| `domain.ts` | IDs, revisions, Constellation lifecycle, Task definitions, Attempts and linked causes, full Claims, receipt references, questions, projections, settings and Host resources |
| `commands.ts` | Atomic plan operations, worker placement, review/answer/state actions and the internal tagged command union |
| `events.ts` | Constellation and Host resource event field sets, codecs and the remote worker outbox entry |
| `rpc.ts` | `ConstellationRpcs`, typed results/refusals and resumable Constellation stream |
| `liveness.ts` | Observed per-Attempt Worker liveness and current activity |
| `stats.ts` | On-demand local metrics, attributed Usage buckets, sequence cut and coverage reasons |

## Commands

`DaemonRpcs` includes `ConstellationRpcs`. Mutations take `commandId` (idempotency)
and `constellationId`. RPC payloads have no `_tag`; the internal
`ConstellationCommand.cases.*.make` constructors add it. A caller's role is
resolved from its authenticated session binding; no command accepts a role.
Desktop App authorization is checked by the Daemon, not asserted in a payload.

- `constellation.plan`: `start?` initializes an absent graph with name,
  Workspace, Lead and settings; `operations` is an atomic Add/Edit/Cancel batch;
  `resources` declares Host-scoped resources. Edit carries a full replacement
  definition and its previous revision. Cancel carries the current Task revision.
- A failed settle classified `capacity` also carries `resetsAt` (on `AttemptSettled`,
  `Attempt` and the `Settled` digest item): the latest reset among the Harness's
  reached Plan Limit windows, or null when unknown (a provider-side capacity error).
  The worker is reported capacity-blocked; nothing redispatches it at the reset.
- Worker placement never widens permissions: a reused Session broader than the
  Lead's permission mode is refused (`E-PERMISSION-CEILING`), and a remote
  placement carries `leadPermissionMode` so the worker Host applies the same ceiling.
- `constellation.dispatch`: named `tasks` pair short Task IDs with placements;
  empty means every ready Task, using `defaultWorker` and graph defaults.
  `New` carries Host, optional Harness/Model/effort, base and optional existing
  worktree/branch; `Existing` names an idle session. Gates use the Lead's session.
- `constellation.review`: Attempt ID, the **Attempt revision** the reviewer saw, and Accept,
  SendBack, Stop, Approve or HandUp. Approve is user-only and HandUp is Lead-only;
  both record metadata while keeping Review. A review of a Claim in review stays current
  from the Claim's `claimRevision` up to the Attempt's revision: progress, approval and
  hand-up don't make it stale, an amended Claim does. Accept supplies the claimed head
  (`mergedHead`) and receipts; before deciding, the owner merges that head into the
  Constellation's `leadBranch`, recorded at start from the Lead's checkout, in the checkout
  holding it or a Daemon-owned lead worktree (ADR 0099; graphs without one use the Lead's
  current branch), with safe git config and no repository hooks, unless it already contains it,
  and refuses with the exact fix on a conflict (`E-MERGE-CONFLICT`, merge aborted), a dirty,
  detached or mid-merge lead checkout (`E-LEAD-DIRTY`, `E-LEAD-DETACHED`, `E-LEAD-MERGING`),
  a deleted lead branch (`E-LEAD-BRANCH`), an unknown directory at the lead worktree's path
  (`E-LEAD-WORKTREE`),
  a merge commit `commit.gpgSign` asks to sign that can't be signed with the Host's own
  signing settings or whose signing failed (`E-MERGE-SIGN`, ADR 0068), or an unfetched head (`E-GIT`). The decider checks the head against the Claim and resolves
  every verified reference. SendBack
  chooses same/existing or new session; `mergeConflictBase` selects that cause.
  The rejected Attempt retains `rejectionReason` and `rejectedBy` (`user` or
  `lead`; both nullable, additive, from `AttemptRejected.reason`/`by`); its old
  Claim stays alongside it in snapshots and status. The retry's first Turn
  carries the verbatim reason and rejected Claim; a MergeConflict names the
  base to merge first. Startup delivers any committed Attempt without its durable
  startup command receipt after a restart, including Initial Attempts. The receipt
  survives the bounded recent-Turn window. Status previews only the latest rejection;
  graph snapshots retain the complete text for Clients.
- `constellation.answer`: a proposal verdict or an answer to a durable question.
- `constellation.message`: a worker, the Lead or all workers, with optional
  authority (`conversation` by default). Only the user may confer decision authority.
- `constellation.set_state`: Pause, Resume, Complete, Archive or HandOver.
- `constellation.worker.{claim,ask,progress,propose,message}`: the current Attempt
  ID and operation data. No revision is required; the binding must belong to its
  latest active Attempt. Peer messages name the recipient Task's short ID.
- `constellation.defaults.get/set`: Host copies of the user-level settings; omitted
  `plan.start.settings` snapshots these defaults for the new Constellation.
- `constellation.worker.claim` refuses `E-CLAIM-REJECTED-HEAD` when the head was
  sent back on an earlier Attempt of the same Task, unless a `decisions` entry
  names that head (the worker's disposition for why it stands).
- `constellation.status`: the shared read-only outline; `since` (a graph revision)
  returns one line per graph event after it plus where things stand; `json` requests the
  folded Constellation and its Task projections in addition to the text.
- `constellation.stats`: `{ constellationId }` returns `ConstellationStats`,
  derived on view from graph, Session, resource and existing Usage histories.
  Unknown durations are nullable with coverage reasons; Clients price its Usage
  buckets. It uses status read authority and never accepts a caller-supplied role.

Command successes have `summary`, `next`, current graph `revision`, and its last event
`sequence` (null for a read/no-op). MCP adapters append `next` to the summary.
`ConstellationRejected` carries every `{code,message,fix}` finding, the current
revision, and the relevant `graph` slice (null when the graph does not exist).
MCP adapters turn it into `isError`; codes are open strings (`E-DEP-CYCLE`,
`E-REVISION`, `E-SETTLED`, `E-CLAIM-DIRTY`, `E-CLAIM-HEAD`, `E-AUTHORITY`, etc.).

## Events and projections

All tags in `ConstellationEvent` and `ResourceEvent` are also `DomainEvent` tags,
so `EventEnvelope` is the persisted codec. **One feed per graph:** the Host feed
only lists Constellations. Its Snapshot carries `ConstellationSummary` values, and
its live events are the listing changes only (`ConstellationStarted`,
`ConstellationStateChanged`, `LeadChanged`). Everything else about a graph comes
from its own `constellation.subscribe` stream: Snapshot → Synchronized → live
Event/resume, plus `LivenessChanged`. Clients resume with `afterSequence`.

The stream Snapshot is complete for a fresh subscriber. It carries:
- the graph;
- `projections`;
- the owner's journal: pending `proposals`, latest `progress` per Attempt,
  unresolved operator `messages`, `digests` (each with the notifications it
  delivered) and `handovers` (each with the graph as it stood: projections,
  in-flight Attempts, open questions, undelivered messages).

All of these are required. Events carry the
new graph `revision`; Attempt changes also carry the new `attemptRevision`;
Task cancellation/promotion carries `taskRevision`. Declaration/edit embeds
`task`; start embeds `attempt`, including its cause, worker, Host, branch and base.
A `ConstellationStarted` embeds the initial graph. Revision allocation and
atomic multi-event decisions belong to the owner Daemon's decider.

`Task` stores its definition, revision and cancellation marker. Task state,
blocked dependencies, latest Attempt, Gate promotion, stale Host and fetched
branch are `TaskProjection` values. A Claim changes an Attempt to review; only
acceptance changes it to accepted. Mechanical settle outcomes skip review.
Only the decider emits `GatePromoted`. Causes use tagged constructors (Initial,
SentBack, MergeConflict, Recover, Followup, Superseded); every linked cause's
`ref` must point backward in the same Task's Attempt history.

`TaskProjection.liveness` is required and nullable (null: nothing observed), with
`WorkerLiveness` describing `latestAttemptId`. It travels in `constellation.status`
JSON results and `constellation.subscribe` Snapshot projections.
The shape is `{current: null | {itemId, turnId, command, startedAt}, lastOutputAt,
contextPercent, queuedInput}`. Both timestamps are Unix epoch milliseconds;
context is an integer percentage or null, and queued input is a nonnegative count.
`current.command` is command text or a tool name; Clients derive elapsed time from
`startedAt` when rendering. Null current means no observed main-session activity.

Live changes use `ConstellationStreamItem.cases.LivenessChanged` with
`{attemptId, liveness}`. This is ephemeral and unsequenced, like session
`ItemProgress`; it neither commits a graph event nor advances revision/sequence.
Every subscriber receives it. Match the Attempt to `latestAttemptId`; ignore updates for replaced Attempts.
The runtime seeds observed facts on subscribe/resume and publishes changes from
Harness events and queued-input delivery, without timers. After reconnect, absent
facts stay unknown rather than fabricating tool timing. The pure graph projection
defaults to null; the runtime producer must enrich it. H's observed source is
`apps/daemon/src/harness/constellation/liveness.ts`; E supplies the producer, and
W/L connects the Session-machine/Harness event drain.

An Attempt's Claim-review fields are required and nullable: `claimedAt`
(AttemptClaimed), `approvedByUserAt` (ClaimApproved), `handedUpAt` /
`handedUpReason` (ClaimHandedUp) and `nudgedAt` (AttemptNudged).

A verified receipt contains a `ToolCallReference` to Host/session/Turn/item;
it does not copy caller-supplied command output as proof. The owner resolves
that persisted item and checks its command, exit code and output. Reported
receipts carry text and optional command/exit code. A Claim with no receipts is
asserted; the decider assigns the acceptance's evidence tier.

Questions are persisted in `NotificationQueued` items (including Claim questions).
Their answers use `OperatorMessageSent.questionId` and a QuestionAnswered digest
item; resolution is journaled with `OperatorMessageResolved`. The graph's
additive `openQuestions` (absent decodes empty) folds the same events into the
questions still waiting: unanswered, on an Attempt that is working, blocked or in
review (`liveQuestions`). A digest empties `pendingNotifications`, never
`openQuestions`, so Clients show questions from `openQuestions`. Answering a closed
question is refused with `E-QUESTION-CLOSED`. Notification IDs
are retained through restart/handover; `LeadNotified.items` lists the IDs consumed
by the one recorded digest Turn. The delivery journal must be atomic with that
Turn, not just an in-memory acknowledgement. `LeadNotified.steered` (additive,
default false) marks a digest steered into the Lead's working Turn `turnId`
instead of a new Turn; `LeadNotified.audit` (additive, nullable `StallAudit`)
carries a stall audit (silent working Attempts, promoted Gates with no Attempt,
a silent Lead) and may be the digest's only content, once per audit `key`.
Its additive `slots` names working Attempts that hold a worker slot with no first
Turn past `workerPhase`'s grace period; each Attempt is named once, whatever the key.
`AttemptSettled.failureKind` and `Attempt.failureKind` / `Attempt.settleReason`
(additive, nullable) classify a failed settle as capacity, transport, harness or
implementation; a `Settled` digest item repeats the kind. A lost settle has none.

`ClaimApproved`, `ClaimHandedUp` and `AttemptNudged` preserve approval, hand-up
and once-only nudge facts. They advance Attempt and graph revisions without
changing state. The first `ClaimApproved` also queues an `Approved` digest item,
so the Lead learns it should accept (which merges the Claim).

`AttemptClaimed` sets `Attempt.claimRevision` to its `attemptRevision`; one that amends
a Claim in review (a changed head on the same Attempt) also sets `previousClaimHead`
(both additive, nullable). A nudge marker commits atomically with its Session-machine Turn.

`AttemptRecoveryContinued` journals the automatic Continue with cause `recover`,
its Turn and durable interruption ID. It does not create a second active Attempt.
Recovery consumes this marker so another restart cannot repeat that Continue;
a second interrupted worker Turn becomes attention (ADR 0004 amendment).

## Hosts and compatibility

`ConstellationOutboxEntry` accepts only worker commands. Its stable `id` is the
owner's idempotency key on relay. The worker Host validates binding/git state;
the Lead's Host revalidates the current graph before committing. Entries wait
when the Desktop App or owner is unavailable; remote Daemons do not communicate
directly. Apply/ack decisions are relayed back by the Desktop App.

Resource declarations, queued requests, grants and releases are Host events.
The lease `id` is its queued `requestId`; grants must consume the FIFO head and
respect the declared capacity. The command process owns the hold; exit or an
explicit user Release records `ResourceReleased`, never an automatic kill.

New Host snapshot fields are optional, and existing events/sessions gain no
required fields. Clients announce `constellation` and/or `host.resources` to
receive the respective new event tags, and defaults RPCs use
`constellation.defaults`. An older Client cannot decode new union variants, so
capability filtering is mandatory. The Constellation surfaces are new and may
change shape until C1 ships; older C1 builds are not supported. Existing session/Workspace/SQL
reducers explicitly leave graph/resource events alone. The Engine folds and indexes graph events, implements cut-based replay/live
subscriptions, and mounts the owner handlers in the normal Host transport.
Provisioning, relay, vendor startup and delivery are injected composition hooks.
