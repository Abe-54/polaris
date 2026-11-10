// -*- mode: Bluespec; -*-
/**
 * A session asks for computer use while it's off (ENG-846): `request_computer_use`.
 *
 * A Harness gets its polaris_desktop tools when it opens: all of them on a Ready Host, only the
 * request tool on an Off one. The request is a `computer-use` approval: Not now (Deny) closes it,
 * Allow is refused, and the Daemon withdraws it once the Host is Ready, telling the agent the
 * tools come on its next Turn. For that to be true, the Harness is stopped after that Turn, so
 * the next Turn reopens it. The code is `apps/daemon/src/engine/computerUseRequests.ts`; see
 * README.md, "Computer use requests".
 *
 * Safety reads ghosts of what the agent was told (`promised`) rather than restating the rules.
 */
module computer_use_request_model {
  /** The Harness keeps running after the Turn the request cleared in. */
  const BUG_NO_REOPEN: bool
  /** An Allow answer clears the request as though computer use were on. */
  const BUG_ALLOW_CLEARS: bool

  type State = {
    hostOn: bool, // the Host is Ready
    turns: Set[int], // sessions with a Turn in flight
    tools: int -> str, // each session's live Harness: "none" (not running), "request" or "full"
    asks: Set[int], // pending computer-use approvals, one per session at most
    reopen: Set[int], // sessions whose Harness stops when their Turn ends
    // Ghosts: sessions told "computer use is on", and what that promise came to.
    promised: Set[int],
    badTold: int, // told it was on while the Host wasn't Ready
    stale: int, // a promised session's next Turn on a Ready Host without the tools
    reopened: int,
    notNows: int,
  }

  pure val sessions = Set(1, 2)

  var cr: State

  /** What the Harness offers when it opens for a Turn: the Host's state then. */
  def opened(s: int): str =
    if (cr.tools.get(s) != "none") cr.tools.get(s) else if (cr.hostOn) "full" else "request"

  /** The Daemon withdraws the request: the agent is told it's on, the Harness reopens later. */
  def told(state: State, s: int): State = {
    ...state, asks: state.asks.exclude(Set(s)), reopen: state.reopen.union(Set(s)),
    promised: state.promised.union(Set(s)), badTold: state.badTold + (if (state.hostOn) 0 else 1),
  }

  action init = cr' = {
    hostOn: false, turns: sessions, tools: sessions.mapBy(_ => "request"), asks: Set(),
    reopen: Set(), promised: Set(), badTold: 0, stale: 0, reopened: 0, notNows: 0,
  }

  /** The agent calls request_computer_use; on a Host already Ready it clears at once. */
  action ask(s: int): bool = all {
    cr.turns.contains(s),
    cr.tools.get(s) == "request",
    not(cr.asks.contains(s)),
    cr' = if (cr.hostOn) told(cr, s) else { ...cr, asks: cr.asks.union(Set(s)) },
  }

  /** The user turns computer use on and the Host turns Ready: every request is withdrawn. */
  action turnOn = cr' = cr.asks.fold({ ...cr, hostOn: true }, (state, s) => told(state, s))

  action turnOff = cr' = { ...cr, hostOn: false }

  /** The user answers a request: "not-now" (Deny) closes it; "allow" is refused. */
  action answer(s: int, how: str): bool = all {
    cr.asks.contains(s),
    cr' =
      if (how == "not-now") { ...cr, asks: cr.asks.exclude(Set(s)), notNows: cr.notNows + 1 }
      else if (BUG_ALLOW_CLEARS) told(cr, s)
      else cr,
  }

  /** The Turn ends: its request is withdrawn, and a Harness due to reopen stops. */
  action endTurn(s: int): bool = {
    val stops = cr.reopen.contains(s) and not(BUG_NO_REOPEN)
    all {
      cr.turns.contains(s),
      cr' = { ...cr, turns: cr.turns.exclude(Set(s)), asks: cr.asks.exclude(Set(s)),
        reopen: if (stops) cr.reopen.exclude(Set(s)) else cr.reopen,
        tools: if (stops) cr.tools.set(s, "none") else cr.tools },
    }
  }

  /** A new Turn, opening the Harness if it isn't running. */
  action startTurn(s: int): bool = {
    val now = opened(s)
    val kept = cr.promised.contains(s) and cr.hostOn
    all {
      not(cr.turns.contains(s)),
      cr' = { ...cr, turns: cr.turns.union(Set(s)), tools: cr.tools.set(s, now),
        promised: cr.promised.exclude(Set(s)),
        stale: cr.stale + (if (kept and now != "full") 1 else 0),
        reopened: cr.reopened + (if (kept and now == "full") 1 else 0) },
    }
  }

  /** A Daemon restart: every Turn is interrupted and every Harness is gone. */
  action restart = cr' = { ...cr, turns: Set(), asks: Set(), reopen: Set(),
    tools: sessions.mapBy(_ => "none") }

  action step = {
    nondet s = sessions.oneOf()
    nondet how = Set("not-now", "allow").oneOf()
    any { ask(s), ask(s), answer(s, how), turnOn, turnOff, endTurn(s), startTurn(s), restart }
  }

  val safety = all {
    // The agent is told computer use is on only when the Host is Ready.
    cr.badTold == 0,
    // Once told, its next Turn on a Ready Host has polaris_desktop's tools.
    cr.stale == 0,
    // A request is pending only for a Turn in flight, from the request tool, while not Ready.
    cr.asks.forall(s => cr.turns.contains(s) and cr.tools.get(s) == "request"),
    cr.asks.size() == 0 or not(cr.hostOn),
  }

  // States the simulation must reach, or `safety` proves little.
  val witnessReopened = cr.reopened > 0
  val witnessNotNow = cr.notNows > 0
}
