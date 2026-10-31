/** Source decisions and per-request grants; audit counters are independent of admission guards. */
module data_approvals_model {
  const BUG_DEFAULT_GRANT: bool
  const BUG_REUSE_ONCE: bool
  const BUG_SESSION_CARDS: bool
  type Waiter = (int, str)
  type DataState = {
    turns: Set[int], local: Set[str], writes: Set[str], exact: Set[str], servers: Set[str],
    denied: Set[str], defaults: Set[str], pending: Set[Waiter], cards: Set[Waiter],
    once: Set[Waiter], credits: Waiter -> int, unauthorizedReads: int, reads: int
  }
  pure val targets = Set("s1/d1/u1", "s1/d2/u1", "s1/d1/u2", "s2/d1/u1")
  pure val sessions = Set(1, 2)
  pure val waiters = tuples(sessions, targets)
  pure def server(t: str): str = if (t == "s2/d1/u1") "s2/u1" else if (t == "s1/d1/u2") "s1/u2" else "s1/u1"
  var data: DataState
  def remembered(t: str): bool = data.exact.contains(t) or data.servers.contains(server(t))
  def policy(t: str): bool = not(data.denied.contains(t)) and (data.local.contains(t) or remembered(t))
  def admitted(s: int,t: str): bool = policy(t) or data.once.contains((s,t)) or data.defaults.contains(t)
  action init = data' = {
    turns: sessions, local: Set(), writes: Set(), exact: Set(), servers: Set(), denied: Set(),
    defaults: Set(), pending: Set(), cards: Set(), once: Set(), credits: waiters.mapBy(_ => 0),
    unauthorizedReads: 0, reads: 0
  }
  action locality(t: str, local: bool): bool = data' = { ...data,
    local: if (local) data.local.union(Set(t)) else data.local.exclude(Set(t)) }
  action changeWrites(t: str): bool = data' = { ...data, writes: data.writes.union(Set(t)),
    defaults: if (BUG_DEFAULT_GRANT and data.local.contains(t)) data.defaults.union(Set(t)) else data.defaults }
  action request(s: int,t: str): bool = all {
    data.turns.contains(s), not(admitted(s,t)), not(data.denied.contains(t)),
    data' = { ...data, pending: data.pending.union(Set((s,t))),
      cards: if (BUG_SESSION_CARDS or not(data.cards.exists(w => w._2 == t))) data.cards.union(Set((s,t))) else data.cards }
  }
  action allow(t: str, wholeServer: bool, remember: bool): bool = all {
    data.cards.exists(w => w._2 == t),
    data' = { ...data,
      pending: data.pending.filter(w => w._2 != t), cards: data.cards.filter(w => w._2 != t),
      exact: if (remember and not(wholeServer)) data.exact.union(Set(t)) else data.exact,
      servers: if (remember and wholeServer) data.servers.union(Set(server(t))) else data.servers,
      once: if (remember) data.once else data.once.union(data.pending.filter(w => w._2 == t)),
      credits: waiters.mapBy(w => if (not(remember) and data.pending.contains(w) and w._2 == t) 1 else data.credits.get(w)),
      denied: data.denied.exclude(Set(t)) }
  }
  action deny(t: str): bool = all {
    data.cards.exists(w => w._2 == t),
    data' = { ...data, pending: data.pending.filter(w => w._2 != t), cards: data.cards.filter(w => w._2 != t),
      denied: data.denied.union(Set(t)), once: data.once.filter(w => w._2 != t) }
  }
  action revoke(t: str): bool = data' = { ...data, exact: data.exact.exclude(Set(t)),
    servers: data.servers.exclude(Set(server(t))), denied: data.denied.exclude(Set(t)),
    defaults: data.defaults.exclude(Set(t)), once: data.once.filter(w => server(w._2) != server(t)) }
  action read(s: int,t: str): bool = all {
    data.turns.contains(s), admitted(s,t),
    data' = { ...data, reads: data.reads + 1,
      unauthorizedReads: data.unauthorizedReads + (if (policy(t) or data.credits.get((s,t)) > 0) 0 else 1),
      once: if (BUG_REUSE_ONCE or policy(t)) data.once else data.once.exclude(Set((s,t))),
      credits: if (policy(t)) data.credits else data.credits.set((s,t),data.credits.get((s,t))-1) }
  }
  action endTurn(s: int): bool = {
    val withdrawn = data.cards.filter(w => w._1 == s).map(w => w._2)
    data' = { ...data, turns: data.turns.exclude(Set(s)),
      pending: data.pending.filter(w => w._1 != s and not(withdrawn.contains(w._2))),
      cards: data.cards.filter(w => w._1 != s), once: data.once.filter(w => w._1 != s),
      credits: waiters.mapBy(w => if (w._1 == s) 0 else data.credits.get(w)) }
  }
  action continueTurn(s: int): bool = data' = { ...data, turns: data.turns.union(Set(s)) }
  action waitExpired = data' = data
  action step = {
    nondet t = targets.oneOf()
    nondet s = sessions.oneOf()
    any { locality(t,true), locality(t,false), changeWrites(t), request(s,t), allow(t,false,true),
      allow(t,true,true), allow(t,false,false), deny(t), revoke(t), read(s,t), endTurn(s), continueTurn(s), waitExpired }
  }
  val safety = all {
    data.unauthorizedReads == 0,
    waiters.forall(w => data.credits.get(w) >= 0),
    targets.forall(t => data.cards.filter(w => w._2 == t).size() <= 1),
    data.pending.forall(w => data.turns.contains(w._1) and data.cards.exists(c => c._2 == w._2)),
    data.once.forall(w => data.turns.contains(w._1))
  }
}
