module constellations {
  const TASKS: Set[int]
  const SESSIONS: Set[int]
  const IDS: Set[int]
  const OWNER: str
  const CAPACITY: int

  type Task = { declared: bool, deps: Set[int], parent: int, gate: bool, canceled: bool, revision: int }
  type Attempt = { task: int, session: int, status: str, ref: int, revision: int, claimRev: int, sha: int, rejectionReason: str, mergeBase: str }
  type Delivery = { id: int, lead: int }
  type Recovery = { attempt: int, interruption: int }
  type EventKind =
    | TaskDeclared({ task: int, deps: Set[int], parent: int, gate: bool })
    | TaskEdited({ task: int, deps: Set[int], parent: int, gate: bool })
    | TaskCanceled(int)
    | AttemptStarted({ task: int, session: int, ref: int, mergeBase: str })
    | AttemptProgressed(int)
    | AttemptClaimed({ attempt: int, sha: int, disposed: bool })
    | ClaimApproved(int)
    | ClaimHandedUp(int)
    | AttemptBlocked({ attempt: int, on: Set[int] })
    | AttemptUnblocked({ attempt: int, cause: str, turn: bool, fresh: bool })
    | AttemptNudged(int)
    | AttemptAccepted({ attempt: int, sha: int })
    | AttemptRejected({ attempt: int, reason: str })
    | FirstTurnStarted(int)
    | AttemptSettled({ attempt: int, outcome: str, stale: bool, commanded: bool, kind: str })
    | GatePromoted(int)
    | LeadHandoverRequested({ id: int, from: int })
    | LeadHandoverCancelled(int)
    | LeadChanged({ to: int, request: int })
    | AttemptInterrupted({ attempt: int, interruption: int, eligible: bool })
    | AttemptStale(int)
    | AttemptFresh(int)
    | WorkerInputDelivered({ id: int, session: int })
    | ConstellationStateChanged(str)
    | NotificationQueued({ id: int, kind: str })
    | LeadNotified({ ids: Set[int], lead: int, steered: bool, audit: Set[int], slots: Set[int] })
    | OutboxApplied(int)
    | AttemptRecoveryContinued(Recovery)
    | ResourceDeclared(int)
    | ResourceLeaseQueued(int)
    | ResourceLeased(int)
    | ResourceReleased(int)
    | ResourceLeaseCanceled(int)
    | ResourceRemoved
  type Event = { host: str, kind: EventKind }
  type View = {
    tasks: int -> Task, attempts: List[Attempt], lead: int, state: str,
    handoverRequest: int, handoverFrom: int, stale: Set[int], inputs: List[{ id: int, session: int }],
    approvals: List[int], handups: List[int], nudges: List[int], firstTurns: List[int], earlyInputs: Set[int],
    blocks: int -> Set[int],
    promotions: List[int], notes: int -> str, deliveries: List[Delivery], steers: int, audited: Set[int],
    slotAudited: Set[int],
    proofs: Set[{ attempt: int, interruption: int }],
    applied: List[int], recoveries: List[Recovery], waiters: List[int],
    holders: Set[int], requests: List[int], grants: List[int], capacity: int, canceled: Set[int],
  }
  type PlanOp = Add({ task: int, deps: Set[int], parent: int, gate: bool })
    | Edit({ task: int, deps: Set[int], parent: int, gate: bool, revision: int })
    | Cancel({ task: int, revision: int })
  type Remote = { attempt: int, sha: int }

  pure val emptyTask = { declared: false, deps: Set(), parent: -1, gate: false, canceled: false, revision: 0 }
  pure val empty: View = {
    tasks: TASKS.mapBy(_ => emptyTask), attempts: [], lead: 0, state: "planning",
    handoverRequest: -1, handoverFrom: -1, stale: Set(), inputs: [],
    approvals: [], handups: [], nudges: [], firstTurns: [], earlyInputs: Set(),
    blocks: Map(),
    proofs: Set(),
    promotions: [], notes: Map(), deliveries: [], steers: 0, audited: Set(), slotAudited: Set(), applied: [], recoveries: [],
    waiters: [], holders: Set(), requests: [], grants: [], capacity: CAPACITY, canceled: Set(),
  }
// The event log is durable; projections and pending notification IDs are always re-folded.
  pure def claimable(v: View, a: int, sha: int): bool = v.attempts.indices().contains(a) and
    (v.attempts[a].status == "working" or v.attempts[a].status == "review" and v.attempts[a].sha != sha)
  // A head an earlier Attempt on the same Task had sent back; claiming it again needs a disposition.
  pure def rejectedHead(v: View, a: int, sha: int): bool = v.attempts.indices().exists(r =>
    r != a and v.attempts[r].task == v.attempts[a].task and v.attempts[r].status == "rejected" and v.attempts[r].sha == sha)
  pure def has(xs: List[int], x: int): bool = xs.indices().exists(i => xs[i] == x)
  pure def active(a: Attempt): bool = Set("working", "blocked", "review").contains(a.status)
  pure def change(v: View, a: int, status: str, sha: int): View = {
    ...v, attempts: v.attempts.replaceAt(a, {
      ...v.attempts[a], status: status, sha: sha, revision: v.attempts[a].revision + 1,
    }),
  }
  // The revision a Claim made: a review from then on saw it, whatever bumped the Attempt since.
  pure def claimedAt(v: View, a: int): View = {
    ...v, attempts: v.attempts.replaceAt(a, { ...v.attempts[a], claimRev: v.attempts[a].revision }),
  }
  pure def apply(v: View, e: EventKind): View = match e {
    | TaskDeclared(p) => { ...v, tasks: v.tasks.set(p.task, {
        declared: true, deps: p.deps, parent: p.parent, gate: p.gate, canceled: false, revision: 1,
      }) }
    | TaskEdited(p) => { ...v, tasks: v.tasks.set(p.task, {
        ...v.tasks.get(p.task), deps: p.deps, parent: p.parent, gate: p.gate, revision: v.tasks.get(p.task).revision + 1,
      }) }
    | TaskCanceled(t) => { ...v, tasks: v.tasks.set(t, {
        ...v.tasks.get(t), canceled: true, revision: v.tasks.get(t).revision + 1,
      }), blocks: v.blocks.keys().mapBy(a => v.blocks.get(a).exclude(Set(t))) }
    | AttemptStarted(p) => { ...v, attempts: v.attempts.append({
        task: p.task, session: p.session, ref: p.ref, status: "working", revision: 1, claimRev: -1, sha: -1, rejectionReason: "", mergeBase: p.mergeBase,
      }) }
    | AttemptProgressed(a) => change(v, a, v.attempts[a].status, v.attempts[a].sha)
    | AttemptClaimed(p) => { ...claimedAt(change(v, p.attempt, "review", p.sha), p.attempt),
        approvals: v.approvals.select(a => a != p.attempt),
        handups: v.handups.select(a => a != p.attempt), nudges: v.nudges.select(a => a != p.attempt) }
    | ClaimApproved(a) => { ...change(v, a, v.attempts[a].status, v.attempts[a].sha), approvals: v.approvals.append(a) }
    | ClaimHandedUp(a) => { ...change(v, a, v.attempts[a].status, v.attempts[a].sha), handups: v.handups.append(a) }
    | AttemptBlocked(p) => { ...change(v, p.attempt, "blocked", v.attempts[p.attempt].sha), blocks: v.blocks.put(p.attempt, p.on) }
    | AttemptUnblocked(p) => { ...change(v, p.attempt, "working", v.attempts[p.attempt].sha), blocks: v.blocks.keys().exclude(Set(p.attempt)).mapBy(a => v.blocks.get(a)), nudges: v.nudges.select(a => a != p.attempt) }
    | AttemptNudged(a) => { ...change(v, a, v.attempts[a].status, v.attempts[a].sha), nudges: v.nudges.append(a) }
    | AttemptAccepted(p) => change(v, p.attempt, "accepted", p.sha)
    | AttemptRejected(p) => {
        val changed = change(v, p.attempt, "rejected", v.attempts[p.attempt].sha)
        { ...changed, attempts: changed.attempts.replaceAt(p.attempt, {
          ...changed.attempts[p.attempt], rejectionReason: p.reason,
        }) }
      }
    | FirstTurnStarted(a) => { ...v, firstTurns: v.firstTurns.append(a) }
    | AttemptSettled(p) => change(v, p.attempt, p.outcome, v.attempts[p.attempt].sha)
    | GatePromoted(t) => { ...v, promotions: v.promotions.append(t), tasks: v.tasks.set(t, { ...v.tasks.get(t), revision: v.tasks.get(t).revision + 1 }) }
    | LeadHandoverRequested(p) => { ...v, handoverRequest: p.id, handoverFrom: p.from }
    | LeadHandoverCancelled(id) => if (v.handoverRequest == id) { ...v, handoverRequest: -1, handoverFrom: -1 } else v
    | LeadChanged(p) => { ...v, lead: p.to, handoverRequest: -1, handoverFrom: -1 }
    | AttemptInterrupted(p) => { ...v, proofs: if (p.eligible) v.proofs.union(Set({ attempt: p.attempt, interruption: p.interruption })) else v.proofs }
    | AttemptStale(a) => { ...v, stale: v.stale.union(Set(a)) }
    | AttemptFresh(a) => { ...v, stale: v.stale.exclude(Set(a)) }
    | WorkerInputDelivered(p) => { ...v, inputs: v.inputs.append(p),
        earlyInputs: v.earlyInputs.union(v.attempts.indices().filter(a =>
          v.attempts[a].session == p.session and v.attempts[a].status == "working"
          and not(has(v.firstTurns, a)))) }
    | ConstellationStateChanged(s) => { ...v, state: s }
    | NotificationQueued(p) => { ...v, notes: v.notes.put(p.id, p.kind) }
    | LeadNotified(p) => { ...v, deliveries: p.ids.fold(v.deliveries, (acc, id) => acc.append({ id: id, lead: p.lead })),
        steers: v.steers + (if (p.steered) 1 else 0), audited: v.audited.union(p.audit),
        slotAudited: v.slotAudited.union(p.slots) }
    | OutboxApplied(id) => { ...v, applied: v.applied.append(id) }
    | AttemptRecoveryContinued(p) => { ...v, recoveries: v.recoveries.append(p) }
    | ResourceDeclared(capacity) => { ...v, capacity: capacity }
    | ResourceRemoved => { ...v, capacity: 0 }
    | ResourceLeaseQueued(id) => { ...v, waiters: v.waiters.append(id), requests: v.requests.append(id) }
    | ResourceLeased(id) => { ...v, holders: v.holders.union(Set(id)), waiters: v.waiters.slice(1, v.waiters.length()), grants: v.grants.append(id) }
    | ResourceReleased(id) => { ...v, holders: v.holders.exclude(Set(id)) }
    | ResourceLeaseCanceled(id) => { ...v, waiters: v.waiters.select(waiter => waiter != id), canceled: v.canceled.union(Set(id)) }
  }
  pure def foldEvents(events: List[Event]): View = events.foldl(empty, (v, e) => apply(v, e.kind))
  // Set folds have no order: the latest Attempt is the greatest index on the Task, not the last visited.
  pure def latest(v: View, t: int): int = v.attempts.indices().fold(-1, (acc, i) => if (v.attempts[i].task == t and i > acc) i else acc)
  // Parent closure is bounded by TASKS; the wire supports arbitrary finite depth.
  pure def children(v: View, t: int): Set[int] = TASKS.filter(c =>
    v.tasks.get(c).declared and not(v.tasks.get(c).canceled) and v.tasks.get(c).parent == t)
  pure def descendants(v: View, t: int): Set[int] = TASKS.fold(children(v, t), (acc, _) =>
    acc.union(acc.fold(Set(), (out, c) => out.union(children(v, c)))))
  pure def lineage(v: View, t: int): Set[int] = if (v.tasks.get(t).parent < 0) Set() else TASKS.fold(
    Set(v.tasks.get(t).parent), (acc, _) =>
      acc.union(acc.fold(Set(), (out, p) => if (v.tasks.keys().contains(p) and v.tasks.get(p).parent >= 0)
        out.union(Set(v.tasks.get(p).parent)) else out)))
  pure def effectiveDeps(v: View, t: int): Set[int] = lineage(v, t).fold(v.tasks.get(t).deps,
    (acc, p) => if (v.tasks.keys().contains(p)) acc.union(v.tasks.get(p).deps) else acc)
  pure def leafAccepted(v: View, t: int): bool = not(v.tasks.get(t).canceled)
    and latest(v, t) >= 0 and v.attempts[latest(v, t)].status == "accepted"
  pure def acceptance(v: View): int -> bool = TASKS.fold(TASKS.mapBy(t => leafAccepted(v, t)), (states, _) =>
    TASKS.mapBy(t => {
      val kids = children(v, t)
      if (kids == Set()) leafAccepted(v, t)
      else not(v.tasks.get(t).canceled) and kids.forall(c => states.get(c))
        and effectiveDeps(v, t).forall(d => states.get(d))
    }))
  pure def accepted(v: View, t: int): bool = if (children(v, t) == Set()) leafAccepted(v, t)
    else acceptance(v).get(t)
  pure def ready(v: View, t: int): bool = v.tasks.get(t).declared and not(v.tasks.get(t).canceled)
    and effectiveDeps(v, t).forall(d => accepted(v, d))
  pure def leafState(v: View, t: int): str =
    if (v.tasks.get(t).canceled) "canceled"
    else if (latest(v, t) < 0 or v.attempts[latest(v, t)].status == "rejected")
      (if (ready(v, t)) "ready" else "waiting")
    else if (v.attempts[latest(v, t)].status == "accepted") "done"
    else v.attempts[latest(v, t)].status
  pure def taskStates(v: View): int -> str = TASKS.fold(TASKS.mapBy(t => leafState(v, t)), (states, _) =>
    TASKS.mapBy(t => {
      val kids = children(v, t)
      if (v.tasks.get(t).canceled or kids == Set()) leafState(v, t)
      else if (kids.exists(c => Set("working", "review", "blocked").contains(states.get(c)))) "working"
      else if (not(ready(v, t))) "waiting"
      else if (kids.forall(c => states.get(c) == "done")) "done"
      else if (kids.exists(c => states.get(c) == "ready")) "ready" else "waiting"
    }))
  pure def taskState(v: View, t: int): str =
    if (children(v, t) == Set()) leafState(v, t) else taskStates(v).get(t)
  pure def liveBlocks(v: View, t: int): Set[int] = v.attempts.indices().fold(Set(), (acc, a) =>
    if (v.attempts[a].task == t and v.attempts[a].status == "blocked" and not(v.tasks.get(t).canceled))
      acc.union(v.blocks.get(a).filter(d => not(v.tasks.get(d).canceled))) else acc)
  pure def waits(v: View, t: int): Set[int] = if (v.tasks.get(t).canceled or accepted(v, t)) Set()
    else effectiveDeps(v, t).union(children(v, t)).union(liveBlocks(v, t)).filter(d => not(v.tasks.get(d).canceled) and not(accepted(v, d)))
  pure def reach(v: View, t: int): Set[int] = TASKS.fold(waits(v, t), (acc, _) =>
    acc.union(acc.fold(Set(), (out, d) => out.union(waits(v, d)))))
  pure def graphStructureValid(v: View): bool = TASKS.forall(t => all {
    not(lineage(v, t).contains(t)),
    v.tasks.get(t).parent < 0 or (v.tasks.keys().contains(v.tasks.get(t).parent) and v.tasks.get(v.tasks.get(t).parent).declared),
    children(v, t) == Set() or (not(v.tasks.get(t).gate) and latest(v, t) < 0),
    v.tasks.get(t).canceled or (v.tasks.get(t).parent < 0 or not(v.tasks.get(v.tasks.get(t).parent).canceled)),
    v.tasks.get(t).canceled or effectiveDeps(v, t).forall(d => not(lineage(v, t).contains(d)) and not(lineage(v, d).contains(t))),
    v.tasks.get(t).canceled or effectiveDeps(v, t).forall(d => v.tasks.get(d).declared and not(v.tasks.get(d).canceled)),
  })
  pure def validGraph(v: View): bool = graphStructureValid(v) and TASKS.forall(t => not(reach(v, t).contains(t)))
  pure def planGraphValid(before: View, after: View): bool = graphStructureValid(after)
    and TASKS.forall(t => waits(after, t).exclude(waits(before, t)).forall(d => d != t and not(reach(after, d).contains(t))))
  pure def cancelEvents(v: View, t: int): List[EventKind] =
    [TaskCanceled(t)].concat(v.attempts.indices().fold([], (notes, a) =>
      if (v.attempts[a].status == "blocked" and v.blocks.get(a).contains(t))
      notes.append(NotificationQueued({ id: 100000 + t * 100 + a, kind: "blocked" })) else notes))
  pure def opEvents(v: View, op: PlanOp): List[EventKind] = match op {
    | Add(p) => if (not(v.tasks.get(p.task).declared)) [TaskDeclared(p)] else []
    | Edit(p) => if (v.tasks.get(p.task).declared and not(v.tasks.get(p.task).canceled)
        and v.tasks.get(p.task).revision == p.revision)
      [TaskEdited({ task: p.task, deps: p.deps, parent: p.parent, gate: p.gate })] else []
    | Cancel(p) => if (v.tasks.get(p.task).declared and not(v.tasks.get(p.task).canceled)
        and v.tasks.get(p.task).revision == p.revision and not(v.attempts.indices().exists(i => v.attempts[i].task == p.task and active(v.attempts[i]))))
      cancelEvents(v, p.task) else []
  }
  pure def planEvents(v: View, ops: List[PlanOp]): List[EventKind] = {
    val batch = ops.foldl({ view: v, events: [], valid: true }, (acc, op) => {
      val events = opEvents(acc.view, op)
      { view: events.foldl(acc.view, (updated, e) => apply(updated, e)),
        events: acc.events.concat(events), valid: acc.valid and events.length() > 0 }
    })
    val roots = batch.events.foldl(Set(), (acc, e) => match e { | TaskCanceled(t) => acc.union(Set(t)) | _ => acc })
    val canceled = TASKS.filter(t => not(batch.view.tasks.get(t).canceled) and lineage(batch.view, t).intersect(roots) != Set())
    val events = canceled.fold(batch.events, (acc, t) => acc.concat(cancelEvents(v, t)))
    val updated = events.foldl(v, (acc, e) => apply(acc, e))
    val stopped = roots.union(canceled).forall(t => latest(v, t) < 0 or not(active(v.attempts[latest(v, t)])))
    if (batch.valid and stopped and planGraphValid(v, updated)) events.concat(promote(updated)) else []
  }
  pure def current(v: View, a: int, rev: int): bool = v.attempts.indices().contains(a)
    and latest(v, v.attempts[a].task) == a and active(v.attempts[a]) and v.attempts[a].revision == rev
  pure def reviewable(v: View, a: int, rev: int): bool = v.attempts.indices().contains(a)
    and latest(v, v.attempts[a].task) == a and active(v.attempts[a])
    and (v.attempts[a].revision == rev
      or v.attempts[a].status == "review" and v.attempts[a].claimRev <= rev and rev <= v.attempts[a].revision)
  pure def promote(v: View): List[EventKind] = TASKS.fold([], (acc, t) =>
    if (v.tasks.get(t).gate and ready(v, t) and not(has(v.promotions, t))) acc.append(GatePromoted(t)) else acc)
  // A promoted Gate nobody carries: the audit names it to the Lead once per stalled state.
  pure def stalledGates(v: View): Set[int] = TASKS.filter(t =>
    v.tasks.get(t).gate and not(v.tasks.get(t).canceled) and has(v.promotions, t) and not(accepted(v, t))
    and (latest(v, t) < 0 or not(active(v.attempts[latest(v, t)]))))
  // Working Attempts with no first Turn. Holding a slot past the grace period is the Host's
  // (`workerPhase`), so the model lets any of them stall.
  pure def stalledSlots(v: View): Set[int] = v.attempts.indices().filter(a =>
    v.attempts[a].status == "working" and latest(v, v.attempts[a].task) == a
    and not(v.stale.contains(a)) and not(has(v.firstTurns, a)))
  pure def finish(v: View, a: int, event: EventKind): List[EventKind] = {
    val updated = apply(v, event)
    val events = [event, NotificationQueued({ id: 10 + 2 * a + (if (v.attempts[a].status == "review") 1 else 0), kind: "settle" })]
    events.concat(promote(updated))
  }

  var log: List[Event]
  var offline: Set[int]
  var appConnected: bool
  var ownerAvailable: bool
  var outbox: int -> Remote
  var interruptions: int -> int
  val view = foldEvents(log)
  val delivered = view.deliveries.foldl(Set(), (acc, d) => acc.union(Set(d.id)))
  val pending = view.notes.keys().exclude(delivered)

  action init = all { log' = [], offline' = Set(), appConnected' = true,
    ownerAvailable' = true, outbox' = Map(), interruptions' = Map() }
  action commit(host: str, events: List[EventKind]): bool = all {
    log' = if (host == OWNER and ownerAvailable) events.foldl(log, (acc, e) => acc.append({ host: host, kind: e })) else log,
    offline' = offline, appConnected' = appConnected, ownerAvailable' = ownerAvailable,
    outbox' = outbox, interruptions' = interruptions,
  }
  action replay(events: List[Event]): bool = all {
    log' = log.concat(events), offline' = offline, appConnected' = appConnected,
    ownerAvailable' = ownerAvailable, outbox' = outbox, interruptions' = interruptions,
  }
  action plan(ops: List[PlanOp]): bool = commit(OWNER, planEvents(view, ops))
  action startWithMergeBase(t: int, s: int, ref: int, mergeBase: str): bool = commit(OWNER,
    if (view.state == "running" and children(view, t) == Set() and ready(view, t)
      and (not(view.tasks.get(t).gate) or has(view.promotions, t))
      and not(view.attempts.indices().exists(i => active(view.attempts[i]) and view.attempts[i].session == s))
      and (latest(view, t) < 0 and ref == -1 or latest(view, t) >= 0 and ref == latest(view, t) and not(active(view.attempts[ref]))))
    [AttemptStarted({ task: t, session: s, ref: ref, mergeBase: mergeBase })] else [])
  action start(t: int, s: int, ref: int): bool = startWithMergeBase(t, s, ref, "")
  pure def retryBrief(v: View, a: int): { reason: str, sha: int, mergeBase: str } = {
    val ref = v.attempts[a].ref
    { reason: if (ref >= 0) v.attempts[ref].rejectionReason else "",
      sha: if (ref >= 0) v.attempts[ref].sha else -1, mergeBase: v.attempts[a].mergeBase }
  }
  action startFirstTurn(a: int): bool = commit(OWNER,
    if (view.attempts.indices().contains(a) and view.attempts[a].status == "working"
      and not(view.stale.contains(a)) and not(has(view.firstTurns, a))) [FirstTurnStarted(a)] else [])
  pure def blockEvents(v: View, a: int, on: Set[int], rev: int): List[EventKind] =
    if (current(v, a, rev) and v.attempts[a].status == "working"
      and not(v.tasks.get(v.attempts[a].task).gate)
      and on.forall(t => v.tasks.get(t).declared and not(v.tasks.get(t).canceled) and t != v.attempts[a].task)
      and on.forall(t => not(reach(v, t).contains(v.attempts[a].task)))
      and (on.size() == 0 or not(on.forall(t => accepted(v, t)))))
      [AttemptBlocked({ attempt: a, on: on }), NotificationQueued({ id: 1000 + rev * 100 + a, kind: "blocked" })] else []
  pure def unblockEvents(v: View, a: int, rev: int, cause: str, turn: bool): List[EventKind] =
    if (current(v, a, rev) and v.attempts[a].status == "blocked" and turn
      and (cause == "Lead" or cause == "Accepted" and v.blocks.get(a).size() > 0 and v.blocks.get(a).forall(t => accepted(v, t))))
      [AttemptUnblocked({ attempt: a, cause: cause, turn: turn, fresh: true })] else []
  action block(a: int, on: Set[int], rev: int): bool = commit(OWNER, blockEvents(view, a, on, rev))
  action unblock(a: int, rev: int, cause: str, turn: bool): bool = commit(OWNER, unblockEvents(view, a, rev, cause, turn))
  action unblockInput(a: int, rev: int, cause: str, turn: bool, fresh: bool): bool = commit(OWNER,
    if (fresh) unblockEvents(view, a, rev, cause, turn) else [])
  action progress(a: int, rev: int): bool = commit(OWNER,
    if (current(view, a, rev) and view.attempts[a].status == "working") [AttemptProgressed(a)] else [])
  action claimAs(a: int, rev: int, sha: int, dirty: bool, onBranch: bool, disposed: bool): bool = commit(OWNER,
    if (current(view, a, rev) and claimable(view, a, sha) and not(dirty) and onBranch and (disposed or not(rejectedHead(view, a, sha))))
    finish(view, a, AttemptClaimed({ attempt: a, sha: sha, disposed: disposed })) else [])
  action claim(a: int, rev: int, sha: int, dirty: bool, onBranch: bool): bool = claimAs(a, rev, sha, dirty, onBranch, false)
  action accept(a: int, rev: int, sha: int): bool = commit(OWNER,
    if (reviewable(view, a, rev) and view.attempts[a].status == "review" and view.attempts[a].sha == sha)
    [AttemptAccepted({ attempt: a, sha: sha })].concat(promote(apply(view, AttemptAccepted({ attempt: a, sha: sha })))) else [])
  action rejectWithReason(a: int, rev: int, reason: str): bool = commit(OWNER,
    if (reviewable(view, a, rev) and Set("review", "blocked").contains(view.attempts[a].status)) [AttemptRejected({ attempt: a, reason: reason })] else [])
  action reject(a: int, rev: int): bool = rejectWithReason(a, rev, "fix")
  action approve(a: int, rev: int): bool = commit(OWNER,
    if (reviewable(view, a, rev) and view.attempts[a].status == "review" and not(has(view.approvals, a)))
    [ClaimApproved(a), NotificationQueued({ id: 50000 + rev * 100 + a, kind: "approved" })] else [])
  action stop(a: int, rev: int): bool = commit(OWNER,
    if (reviewable(view, a, rev)) finish(view, a, AttemptSettled({ attempt: a, outcome: "lost", stale: offline.contains(view.attempts[a].session), commanded: true, kind: "" })) else [])
  action harnessFailAs(a: int, kind: str): bool = commit(OWNER,
    if (view.attempts.indices().contains(a) and active(view.attempts[a]) and not(offline.contains(view.attempts[a].session)))
    finish(view, a, AttemptSettled({ attempt: a, outcome: "failed", stale: false, commanded: false, kind: kind })) else [])
  action harnessFail(a: int): bool = harnessFailAs(a, "harness")
  action ask(a: int, id: int): bool = commit(OWNER,
    if (view.attempts.indices().contains(a) and active(view.attempts[a]) and not(view.notes.keys().contains(id)))
    [NotificationQueued({ id: id, kind: "question" })] else [])
  // Whether the Lead's Turn is live belongs to the Session machine; here a steer is a free choice.
  action deliverAs(steered: bool): bool = commit(OWNER,
    if (view.state == "running" and pending.size() > 0) [LeadNotified({ ids: pending, lead: view.lead, steered: steered, audit: Set(), slots: Set() })] else [])
  action deliver = deliverAs(false)
  action deliverSteered = deliverAs(true)
  // A stall audit rides the digest; alone it needs a stalled Gate the Lead has not been told about.
  action audit = commit(OWNER,
    if (view.state == "running" and stalledGates(view).exclude(view.audited) != Set())
      [LeadNotified({ ids: pending, lead: view.lead, steered: false, audit: stalledGates(view).exclude(view.audited), slots: Set() })] else [])
  // A slot stall rides a digest too, once per Attempt: its stall ends only with a first Turn or its end.
  action auditSlot(a: int): bool = commit(OWNER,
    if (view.state == "running" and stalledSlots(view).exclude(view.slotAudited).contains(a))
      [LeadNotified({ ids: pending, lead: view.lead, steered: false, audit: Set(), slots: Set(a) })] else [])
  action requestHandover(id: int): bool = commit(OWNER,
    if (Set("planning", "running", "paused").contains(view.state))
      [LeadHandoverRequested({ id: id, from: view.lead })] else [])
  action cancelHandover: bool = commit(OWNER,
    if (view.handoverRequest >= 0) [LeadHandoverCancelled(view.handoverRequest)] else [])
  pure def handoverEvents(v: View, id: int, s: int): List[EventKind] = {
    val gates = v.attempts.indices().filter(a => active(v.attempts[a]) and v.attempts[a].session == v.lead and v.tasks.get(v.attempts[a].task).gate)
    gates.fold([], (events, a) => events.concat(finish(v, a, AttemptSettled({ attempt: a, outcome: "lost", stale: false, commanded: true, kind: "" })))).append(LeadChanged({ to: s, request: id }))
  }
  action finishHandover(id: int, s: int): bool = commit(OWNER,
    if (view.handoverRequest == id and view.handoverFrom == view.lead and s != view.lead
      and Set("planning", "running", "paused").contains(view.state))
      handoverEvents(view, id, s) else [])
  action handover(s: int): bool = commit(OWNER, if (s != view.lead) handoverEvents(view, -1, s) else [])
  pure def lifecycleTransition(previous: str, target: str): bool =
    previous == "planning" and target == "running" or previous == "running" and Set("paused", "completed").contains(target)
    or previous == "paused" and Set("running", "completed").contains(target) or previous == "completed" and target == "archived"
  action setState(s: str): bool = commit(OWNER, if (lifecycleTransition(view.state, s)) [ConstellationStateChanged(s)] else [])
  action interrupt(a: int): bool = all {
    log' = log.append({ host: OWNER, kind: AttemptInterrupted({ attempt: a, interruption: if (interruptions.keys().contains(a)) interruptions.get(a) + 1 else 1, eligible: true }) }), offline' = offline, appConnected' = appConnected, ownerAvailable' = ownerAvailable,
    outbox' = outbox, interruptions' = interruptions.put(a, if (interruptions.keys().contains(a)) interruptions.get(a) + 1 else 1),
  }
  action recover(a: int): bool = commit(OWNER,
    if (view.attempts.indices().contains(a) and view.attempts[a].status == "working"
      and interruptions.keys().contains(a) and interruptions.get(a) == 1 and view.proofs.contains({ attempt: a, interruption: interruptions.get(a) }) and not(view.recoveries.indices().exists(i => view.recoveries[i].attempt == a)))
    [AttemptRecoveryContinued({ attempt: a, interruption: interruptions.get(a) })] else [])
  // The simulator samples the same eligible interruptions that runtime recovery examines.
  action recoverPending = {
    val candidates = view.attempts.indices().filter(a => view.attempts[a].status == "working"
      and interruptions.keys().contains(a) and interruptions.get(a) == 1
      and not(view.recoveries.indices().exists(i => view.recoveries[i].attempt == a)))
    nondet a = (if (candidates.size() > 0) candidates else Set(-1)).oneOf()
    recover(a)
  }
  action restart = all { log' = log, offline' = offline, appConnected' = appConnected,
    ownerAvailable' = true, outbox' = outbox, interruptions' = interruptions }
  action availability(app: bool, owner: bool, stale: Set[int]): bool = all {
    log' = log, offline' = stale, appConnected' = app, ownerAvailable' = owner,
    outbox' = outbox, interruptions' = interruptions,
  }
  action enqueue(id: int, a: int, sha: int): bool = all {
    not(outbox.keys().contains(id)), log' = log, offline' = offline,
    appConnected' = appConnected, ownerAvailable' = ownerAvailable,
    outbox' = outbox.put(id, { attempt: a, sha: sha }), interruptions' = interruptions,
  }
  action relay(id: int): bool = commit(OWNER,
    if (appConnected and outbox.keys().contains(id) and not(has(view.applied, id))) {
      val r = outbox.get(id)
      val appliedEvents = [OutboxApplied(id)]
      appliedEvents.concat(if (view.attempts.indices().contains(r.attempt)
        and current(view, r.attempt, view.attempts[r.attempt].revision) and claimable(view, r.attempt, r.sha) and not(rejectedHead(view, r.attempt, r.sha)))
        finish(view, r.attempt, AttemptClaimed({ attempt: r.attempt, sha: r.sha, disposed: false })) else [])
    } else [])
  action request(id: int): bool = commit(OWNER, if (view.capacity > 0 and not(has(view.requests, id))) [ResourceLeaseQueued(id)] else [])
  action grant = commit(OWNER, if (view.waiters.length() > 0 and view.holders.size() < view.capacity) [ResourceLeased(view.waiters[0])] else [])
  action cancelLease(id: int): bool = commit(OWNER, if (has(view.waiters, id)) [ResourceLeaseCanceled(id)] else [])
  action release(id: int): bool = commit(OWNER, if (view.holders.contains(id)) [ResourceReleased(id)] else [])

  action step = {
    nondet t = TASKS.oneOf()
    nondet s = SESSIONS.oneOf()
    nondet id = IDS.oneOf()
    nondet a = view.attempts.indices().union(Set(-1)).oneOf()
    val rev = if (view.attempts.indices().contains(a)) view.attempts[a].revision else 1
    val claimRev = if (view.attempts.indices().contains(a)) view.attempts[a].claimRev else 1
    nondet dep = TASKS.oneOf()
    any {
      plan([Add({ task: t, deps: Set(), parent: -1, gate: t == 2 })]),
      plan([Edit({ task: t, deps: Set(dep), parent: -1, gate: t == 2, revision: rev })]),
      plan([Cancel({ task: t, revision: rev })]),
      start(t, s, latest(view, t)), progress(a, rev), claim(a, rev, 42, false, true), claimAs(a, rev, 42, false, true, true),
      block(a, Set(dep), rev), block(a, Set(), rev), unblock(a, rev, "Accepted", true), unblock(a, rev, "Lead", true),
      claim(a, rev, 42, true, true), accept(a, rev, 42), accept(a, rev, 43),
      accept(a, claimRev, 42), approve(a, rev), reject(a, rev), startFirstTurn(a), stop(a, rev), harnessFail(a),
      ask(a, id), deliver, deliverSteered, audit, auditSlot(a), harnessFailAs(a, "capacity"), handover(s), requestHandover(id), cancelHandover, finishHandover(id, s), setState("running"), setState("paused"),
      all { TASKS.forall(task => accepted(view, task)), setState("completed") },
      setState("archived"), interrupt(a), recoverPending, restart,
      availability(false, true, Set(s)), availability(true, false, Set()), availability(true, true, Set()),
      enqueue(id, a, 42), relay(id), request(id), grant, release(id), cancelLease(id), commit("worker-host", [LeadChanged({ to: s, request: -1 })]),
    }
  }

  // `quint run --step=recoveryStep`: the Attempt lifecycle around a restart, so `witnessRecovery`
  // doesn't depend on how many other options `step` has (ENG-352).
  action recoveryStep = {
    nondet t = TASKS.oneOf()
    nondet s = SESSIONS.oneOf()
    nondet a = view.attempts.indices().union(Set(-1)).oneOf()
    val rev = if (view.attempts.indices().contains(a)) view.attempts[a].revision else 1
    nondet dep = TASKS.oneOf()
    any {
      plan([Add({ task: t, deps: Set(), parent: -1, gate: t == 2 })]), setState("running"),
      start(t, s, latest(view, t)), startFirstTurn(a), progress(a, rev), claim(a, rev, 42, false, true),
      block(a, Set(dep), rev), unblock(a, rev, "Lead", true), reject(a, rev), stop(a, rev), harnessFail(a),
      handover(s), interrupt(a), recoverPending, restart, availability(true, false, Set()), availability(true, true, Set()),
    }
  }

  val graphAcyclic = validGraph(view)
  val firstTurnValid = log.indices().forall(i => match log[i].kind {
    | FirstTurnStarted(a) => { val before = foldEvents(log.slice(0, i));
        before.attempts.indices().contains(a) and before.attempts[a].status == "working"
        and latest(before, before.attempts[a].task) == a and not(before.stale.contains(a))
        and not(before.earlyInputs.contains(a)) }
    | _ => true
  })
  val claimsValid = log.indices().forall(i => match log[i].kind {
    | AttemptClaimed(p) => claimable(foldEvents(log.slice(0, i)), p.attempt, p.sha)
      and (p.disposed or not(rejectedHead(foldEvents(log.slice(0, i)), p.attempt, p.sha)))
    | _ => true
  })
  val firstTurnAtMostOnce = view.firstTurns.length() == view.firstTurns.foldl(Set(), (acc, a) => acc.union(Set(a))).size()
  val causesPointBackward = view.attempts.indices().forall(i => view.attempts[i].ref == -1
    or view.attempts[i].ref >= 0 and view.attempts[i].ref < i and view.attempts[view.attempts[i].ref].task == view.attempts[i].task)
  val taskFollowsLatestAttempt = TASKS.forall(t => latest(view, t) < 0 or view.tasks.get(t).canceled
    or taskState(view, t) == leafState(view, t))
  val gatePromotedOnlyAfterAccepted = log.indices().forall(i => match log[i].kind {
    | GatePromoted(t) => ready(foldEvents(log.slice(0, i)), t) and view.tasks.get(t).gate
    | _ => true
  }) and view.promotions.length() == view.promotions.foldl(Set(), (acc, x) => acc.union(Set(x))).size()
  val handoverRequestOrdered = log.indices().forall(i => {
    val before = foldEvents(log.slice(0, i))
    match log[i].kind {
      | LeadHandoverRequested(p) => p.from == before.lead and Set("planning", "running", "paused").contains(before.state)
      | LeadChanged(p) => p.request < 0 or (before.handoverRequest == p.request and before.handoverFrom == before.lead
          and Set("planning", "running", "paused").contains(before.state))
      | _ => true
    }
  })
  val inputDeliveredAtMostOnce = view.inputs.length() == view.inputs.foldl(Set(), (acc, p) => acc.union(Set(p))).size()
  val oneLead = SESSIONS.contains(view.lead)
  val oneActiveAttemptPerSession = SESSIONS.forall(s => view.attempts.select(a => a.session == s and active(a)).length() <= 1)
  val queuedIds = log.foldl([], (acc, e) => match e.kind {
    | NotificationQueued(p) => acc.append(p.id)
    | _ => acc
  })
  val settlesHaveNotifications = log.indices().forall(i => match log[i].kind {
    | AttemptClaimed(_) => i + 1 < log.length() and (match log[i + 1].kind { | NotificationQueued(_) => true | _ => false })
    | AttemptSettled(_) => i + 1 < log.length() and (match log[i + 1].kind { | NotificationQueued(_) => true | _ => false })
    | _ => true
  })
  val exactlyOnceDelivery = queuedIds.length() == queuedIds.foldl(Set(), (acc, id) => acc.union(Set(id))).size()
    and settlesHaveNotifications and view.deliveries.length() == delivered.size()
    and delivered.subseteq(view.notes.keys()) and pending.union(delivered) == view.notes.keys()
  val settledAttemptImmutable = log.indices().forall(i => {
    val before = foldEvents(log.slice(0, i))
    val after = foldEvents(log.slice(0, i + 1))
    before.attempts.indices().forall(a => active(before.attempts[a]) or before.attempts[a] == after.attempts[a])
  })
  val outboxAppliedExactlyOnce = view.applied.length() == view.applied.foldl(Set(), (acc, x) => acc.union(Set(x))).size()
  val onlyOwnerCommits = log.indices().forall(i => match log[i].kind {
    | FirstTurnStarted(_) => true
    | _ => log[i].host == OWNER
  })
  val recoveryHasEligibleProof = log.indices().forall(i => match log[i].kind {
    | AttemptRecoveryContinued(p) => { val before = foldEvents(log.slice(0, i)); before.proofs.contains({ attempt: p.attempt, interruption: p.interruption }) }
    | _ => true
  })
  val recoveryAtMostOnce = view.recoveries.length() == view.recoveries.foldl(Set(), (acc, x) => acc.union(Set(x))).size()
    and view.attempts.indices().forall(a => view.recoveries.select(r => r.attempt == a).length() <= 1)
  val settlementOutcomesValid = log.indices().forall(i => match log[i].kind {
    | AttemptSettled(p) => Set("lost", "failed").contains(p.outcome)
    | _ => true
  })
  // A failed settle carries one classified kind; a lost (commanded) settle carries none.
  val failureKindValid = log.indices().forall(i => match log[i].kind {
    | AttemptSettled(p) => if (p.outcome == "failed") Set("capacity", "transport", "harness", "implementation").contains(p.kind) else p.kind == ""
    | _ => true
  })
  // A delivery says something: pending items, or an audit naming Gates that were stalled when it committed.
  val auditNamesStalledGates = log.indices().forall(i => match log[i].kind {
    | LeadNotified(p) => (p.ids != Set() or p.audit != Set() or p.slots != Set()) and p.audit.subseteq(stalledGates(foldEvents(log.slice(0, i))))
    | _ => true
  })
  // A slot stall named to the Lead was one when it committed, and no earlier audit named it.
  val slotAuditOncePerStall = log.indices().forall(i => match log[i].kind {
    | LeadNotified(p) => { val before = foldEvents(log.slice(0, i));
        p.slots.subseteq(stalledSlots(before)) and p.slots.intersect(before.slotAudited) == Set() }
    | _ => true
  })
  val staleNeverSettlesWithoutCommand = log.indices().forall(i => match log[i].kind {
    | AttemptSettled(p) => not(p.stale) or p.commanded
    | _ => true
  })
  val noOldLeadDelivery = log.indices().forall(i => match log[i].kind {
    | LeadNotified(p) => p.lead == foldEvents(log.slice(0, i)).lead
    | _ => true
  })
  val acceptanceMatchesClaim = log.indices().forall(i => match log[i].kind {
    | AttemptAccepted(p) => foldEvents(log.slice(0, i)).attempts[p.attempt].status == "review"
      and foldEvents(log.slice(0, i)).attempts[p.attempt].sha == p.sha
    | _ => true
  })
  val reviewMetadataValid = log.indices().forall(i => match log[i].kind {
    | ClaimApproved(a) => foldEvents(log.slice(0, i)).attempts[a].status == "review"
    | ClaimHandedUp(a) => foldEvents(log.slice(0, i)).attempts[a].status == "review"
    | AttemptNudged(a) => foldEvents(log.slice(0, i)).attempts[a].status == "working"
    | AttemptRejected(p) => Set("review", "blocked").contains(foldEvents(log.slice(0, i)).attempts[p.attempt].status)
    | _ => true
  }) and view.nudges.length() == view.nudges.foldl(Set(), (acc, a) => acc.union(Set(a))).size()
    and view.approvals.length() == view.approvals.foldl(Set(), (acc, a) => acc.union(Set(a))).size()
    and view.handups.length() == view.handups.foldl(Set(), (acc, a) => acc.union(Set(a))).size()
  val blockTransitionsValid = log.indices().forall(i => {
    val before = foldEvents(log.slice(0, i))
    match log[i].kind {
      | AttemptBlocked(p) => before.attempts[p.attempt].status == "working"
        and not(before.tasks.get(before.attempts[p.attempt].task).gate)
        and p.on.forall(t => before.tasks.get(t).declared and not(before.tasks.get(t).canceled) and t != before.attempts[p.attempt].task)
        and p.on.forall(t => not(reach(before, t).contains(before.attempts[p.attempt].task)))
        and (p.on.size() == 0 or not(p.on.forall(t => accepted(before, t))))
      | AttemptUnblocked(p) => before.attempts[p.attempt].status == "blocked" and p.turn and p.fresh
        and (p.cause == "Lead" or p.cause == "Accepted" and before.blocks.get(p.attempt).size() > 0 and before.blocks.get(p.attempt).forall(t => accepted(before, t)))
      | _ => true
    }
  })
  val lifecycleValid = log.indices().forall(i => match log[i].kind {
    | ConstellationStateChanged(s) => lifecycleTransition(foldEvents(log.slice(0, i)).state, s)
    | _ => true
  })
  val resourceCapacity = log.indices().forall(i => {
    val v = foldEvents(log.slice(0, i + 1))
    v.holders.size() <= v.capacity
  })
  val resourceRemovalSafe = log.indices().forall(i => match log[i].kind {
    | ResourceRemoved => foldEvents(log.slice(0, i)).holders == Set() and foldEvents(log.slice(0, i)).waiters == []
    | ResourceLeaseQueued(_) => foldEvents(log.slice(0, i)).capacity > 0
    | _ => true
  })
  val fifoGrantOrder = log.indices().forall(i => match log[i].kind {
    | ResourceLeased(id) => foldEvents(log.slice(0, i)).waiters.length() > 0 and foldEvents(log.slice(0, i)).waiters[0] == id
    | _ => true
  })
  // Liveness requires the owner to return, holders to release, and the grant action to run fairly.
  temporal fifoWaiterEventuallyGranted = IDS.forall(id =>
    (always(ownerAvailable and view.capacity > 0 and not(view.canceled.contains(id))) and grant.weakFair(log) and release(id).weakFair(log)
      and IDS.forall(holder => release(holder).weakFair(log)))
    implies (has(view.waiters, id) leadsTo has(view.grants, id)))
  temporal everyNotificationEventuallyDelivered =
    (always(ownerAvailable and view.state == "running") and deliver.weakFair(log))
    implies (0.to(30).forall(id => view.notes.keys().contains(id) leadsTo delivered.contains(id)))
  val safety = all {
    graphAcyclic, causesPointBackward, taskFollowsLatestAttempt, gatePromotedOnlyAfterAccepted,
    oneLead, firstTurnValid, claimsValid, firstTurnAtMostOnce, oneActiveAttemptPerSession, exactlyOnceDelivery, settledAttemptImmutable,
    outboxAppliedExactlyOnce, onlyOwnerCommits, recoveryAtMostOnce, recoveryHasEligibleProof, settlementOutcomesValid, staleNeverSettlesWithoutCommand,
    noOldLeadDelivery, handoverRequestOrdered, inputDeliveredAtMostOnce, blockTransitionsValid, lifecycleValid, reviewMetadataValid, resourceCapacity, resourceRemovalSafe, fifoGrantOrder, acceptanceMatchesClaim,
    failureKindValid, auditNamesStalledGates, slotAuditOncePerStall,
  }
  val witnessClaim = view.attempts.indices().exists(i => view.attempts[i].status == "review")
  val witnessAccepted = view.attempts.indices().exists(i => view.attempts[i].status == "accepted")
  val witnessGate = view.promotions.length() > 0
  val witnessHandover = view.lead != 0
  val witnessDelivery = view.deliveries.length() > 0
  val witnessSteeredDelivery = view.steers > 0
  val witnessAudit = view.audited != Set()
  val witnessSlotAudit = view.slotAudited != Set()
  val witnessRelay = view.applied.length() > 0
  val witnessRecovery = view.recoveries.length() > 0
  val witnessLease = view.grants.length() > 0
}


module current_constellations {
  import constellations(
    TASKS = Set(0, 1, 2), SESSIONS = Set(0, 1, 2, 3), IDS = Set(0, 1, 2, 3, 4, 5),
    OWNER = "lead-host", CAPACITY = 2,
  ).*
}

// Ephemeral Client transport facts; acknowledgements alone commit the durable owner unblock.
module constellation_delivery_relay {
  type Relay = {
    dependencyAccepted: bool, busy: bool, inFlight: bool, receipt: bool,
    ownerConnected: bool, ownerEpoch: int, launchEpoch: int,
    ackEpoch: int, ownerAtAck: int, acknowledged: bool, blocked: bool,
    unblocks: int, attempts: int, wake: bool, reconnectedDuringApply: bool,
  }
  var relay: Relay
  action init = relay' = {
    dependencyAccepted: false, busy: true, inFlight: false, receipt: false,
    ownerConnected: true, ownerEpoch: 0, launchEpoch: -1,
    ackEpoch: -1, ownerAtAck: -1, acknowledged: false, blocked: true,
    unblocks: 0, attempts: 0, wake: false, reconnectedDuringApply: false,
  }
  action acceptDependency = relay' = { ...relay, dependencyAccepted: true, wake: true }
  action launch = all {
    relay.dependencyAccepted and relay.ownerConnected and relay.wake,
    not(relay.inFlight) and not(relay.acknowledged) and relay.attempts < 2,
    relay' = { ...relay, inFlight: true, launchEpoch: relay.ownerEpoch, attempts: relay.attempts + 1, wake: false },
  }
  action turnEnded = relay' = { ...relay, busy: false }
  action applyReceipt = all {
    relay.inFlight and not(relay.busy),
    relay' = { ...relay, receipt: true },
  }
  action disconnectOwner = relay' = { ...relay, ownerConnected: false }
  action reconnectOwner = relay' = {
    ...relay, ownerConnected: true, ownerEpoch: relay.ownerEpoch + 1, attempts: 0, wake: true,
    reconnectedDuringApply: relay.reconnectedDuringApply or relay.inFlight,
  }
  action cleanup = relay' = { ...relay, inFlight: false, wake: true }
  action graphChanged = relay' = { ...relay, attempts: 0, wake: true }
  action acknowledge = all {
    relay.inFlight and relay.receipt and relay.ownerConnected and not(relay.acknowledged),
    relay' = { ...relay, acknowledged: true, blocked: false, unblocks: relay.unblocks + 1,
      ackEpoch: relay.ownerEpoch, ownerAtAck: relay.ownerEpoch },
  }
  action step = any {
    acceptDependency, launch, turnEnded, applyReceipt, disconnectOwner,
    reconnectOwner, cleanup, graphChanged, acknowledge,
  }
  val safety = relay.unblocks <= 1 and (relay.acknowledged implies all {
    relay.receipt, not(relay.busy), not(relay.blocked), relay.ackEpoch == relay.ownerAtAck,
  })
  val witnessReconnectAck = relay.reconnectedDuringApply and relay.acknowledged
  val witnessRetry = relay.attempts == 2
}
