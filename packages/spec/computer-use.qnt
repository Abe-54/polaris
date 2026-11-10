// -*- mode: Bluespec; -*-
/**
 * Computer use (ENG-846, ADR 0107): app approvals, headed-input approvals, the Host's
 * always-allowed list, the always-refused list and one session per app.
 *
 * It refines the HRequest/Respond lifecycle of `polaris`: an `app` or `headed-input` approval
 * is a request like any other there. What this adds is what an answer grants, to whom and for
 * how long. Nothing here reads a permission mode or a Harness: the policy has neither input.
 * The code is `packages/protocol/src/computerUsePolicy.ts`; see README.md, "Computer use".
 *
 * Safety counts the actions the user never covered (`badActs`) from ghost records of what
 * each user answer said, rather than restating the admission predicate.
 */
module computer_use_model {
  /** A headed-input approval answered "always" is remembered for the Host. */
  const BUG_HEADED_ALWAYS: bool
  /** A Turn's end leaves its apps controlled. */
  const BUG_LOCK_SURVIVES_TURN: bool
  /** "Always allow" also grants the asking session, so removing the app leaves it allowed. */
  const BUG_REMOVED_STILL_ALLOWED: bool

  type Grant = (int, str) // (session, app)
  type Card = (int, str, str) // (session, app, "app" | "headed-input")
  type State = {
    turns: Set[int], // sessions with a Turn in flight
    always: Set[str], // the Host's always-allowed apps
    allowed: Set[Grant], // apps allowed for a session
    headed: Set[Grant], // headed input allowed for a session, in an app
    headedAlways: Set[str], // only the BUG_HEADED_ALWAYS mutant fills it
    cards: Set[Card], // pending approvals
    controller: str -> int, // the session controlling each app, or NOBODY
    // Ghosts: what the user said for each session, and the actions it didn't cover.
    saidApp: Set[Grant],
    saidHeaded: Set[Grant],
    acts: int,
    badActs: int,
  }

  pure val apps = Set("figma", "notes", "keychain")
  /** The built-in always-refused list. */
  pure val refused = Set("keychain")
  pure val sessions = Set(1, 2)
  pure val NOBODY = 0

  var cu: State

  def appAllowed(s: int, a: str): bool = cu.always.contains(a) or cu.allowed.contains((s, a))
  def headedAllowed(s: int, a: str): bool = cu.headed.contains((s, a)) or cu.headedAlways.contains(a)

  /** `decideAppUse`: "refused" | "in-use" | "app" | "headed-input" (open that approval) | "allowed". */
  def decision(s: int, a: str, physical: bool): str =
    if (refused.contains(a)) "refused"
    else if (cu.controller.get(a) != NOBODY and cu.controller.get(a) != s) "in-use"
    else if (not(appAllowed(s, a))) "app"
    else if (physical and not(headedAllowed(s, a))) "headed-input"
    else "allowed"

  /** The user covered this action: by what they answered, never by what the policy stored. */
  def covered(s: int, a: str, physical: bool): bool = and {
    not(refused.contains(a)),
    cu.controller.get(a) == NOBODY or cu.controller.get(a) == s,
    cu.always.contains(a) or cu.saidApp.contains((s, a)),
    not(physical) or cu.saidHeaded.contains((s, a)),
  }

  action init = cu' = {
    turns: sessions, always: Set(), allowed: Set(), headed: Set(), headedAlways: Set(),
    cards: Set(), controller: apps.mapBy(_ => NOBODY), saidApp: Set(), saidHeaded: Set(),
    acts: 0, badActs: 0,
  }

  /** A computer use tool call in a Turn: it acts, opens an approval, or is refused. */
  action use(s: int, a: str, physical: bool): bool = {
    val d = decision(s, a, physical)
    all {
      cu.turns.contains(s),
      cu' =
        if (d == "allowed")
          { ...cu, controller: cu.controller.set(a, s), acts: cu.acts + 1,
            badActs: cu.badActs + (if (covered(s, a, physical)) 0 else 1) }
        else if (d == "app" or d == "headed-input") { ...cu, cards: cu.cards.union(Set((s, a, d))) }
        else cu,
    }
  }

  /**
   * The user answers a session's card: "session" | "always" | "deny". "always" on a
   * headed-input card is refused (`appDecisionRefusal`): nothing changes and the card stays.
   */
  action answer(s: int, a: str, kind: str, how: str): bool = {
    val closed = { ...cu, cards: cu.cards.exclude(Set((s, a, kind))) }
    all {
      cu.cards.contains((s, a, kind)),
      cu' =
        if (how == "deny") closed
        else if (kind == "app" and how == "session")
          { ...closed, allowed: cu.allowed.union(Set((s, a))), saidApp: cu.saidApp.union(Set((s, a))) }
        else if (kind == "app")
          { ...closed, always: cu.always.union(Set(a)),
            allowed: if (BUG_REMOVED_STILL_ALLOWED) cu.allowed.union(Set((s, a))) else cu.allowed }
        else if (how == "session")
          { ...closed, headed: cu.headed.union(Set((s, a))), saidHeaded: cu.saidHeaded.union(Set((s, a))) }
        else if (BUG_HEADED_ALWAYS)
          { ...closed, headedAlways: cu.headedAlways.union(Set(a)), saidHeaded: cu.saidHeaded.union(Set((s, a))) }
        else cu,
    }
  }

  /** The Turn ends: its cards are withdrawn and its apps released (`releaseSession`). */
  action endTurn(s: int): bool = cu' = {
    ...cu, turns: cu.turns.exclude(Set(s)), cards: cu.cards.filter(c => c._1 != s),
    controller: if (BUG_LOCK_SURVIVES_TURN) cu.controller
      else apps.mapBy(a => if (cu.controller.get(a) == s) NOBODY else cu.controller.get(a)),
  }

  action startTurn(s: int): bool = cu' = { ...cu, turns: cu.turns.union(Set(s)) }

  /** `computerUse.removeAllowedApp` (`withoutAllowedApp`). */
  action removeAlways(a: str): bool = cu' = { ...cu, always: cu.always.exclude(Set(a)) }

  /** Archive, only between Turns: the session's approvals go with it (`forgetSession`). */
  action archive(s: int): bool = all {
    not(cu.turns.contains(s)),
    cu' = { ...cu, allowed: cu.allowed.filter(g => g._1 != s), headed: cu.headed.filter(g => g._1 != s),
      saidApp: cu.saidApp.filter(g => g._1 != s), saidHeaded: cu.saidHeaded.filter(g => g._1 != s) },
  }

  /** A Daemon restart interrupts every Turn; approvals are folded from the log again. */
  action restart = cu' = { ...cu, turns: Set(), cards: Set(), controller: apps.mapBy(_ => NOBODY) }

  action step = {
    nondet s = sessions.oneOf()
    nondet a = apps.oneOf()
    nondet physical = Set(true, false).oneOf()
    // Answers land on a pending card when there is one, so chains of approvals complete.
    nondet c = (if (cu.cards.size() > 0) cu.cards else Set((1, "figma", "app"))).oneOf()
    nondet how = Set("session", "always", "deny").oneOf()
    any {
      use(s, a, physical), use(s, a, physical), answer(c._1, c._2, c._3, how), endTurn(s),
      startTurn(s), removeAlways(a), archive(s), restart,
    }
  }

  val safety = all {
    // Every action was covered by the user's own answers and by the lock.
    cu.badActs == 0,
    // An app is controlled only by a session with a Turn in flight.
    apps.forall(a => cu.controller.get(a) == NOBODY or cu.turns.contains(cu.controller.get(a))),
    // An approval is pending only for a Turn in flight, and never for a refused app.
    cu.cards.forall(c => cu.turns.contains(c._1) and not(refused.contains(c._2))),
    // A refused app is never controlled and never always-allowed.
    refused.forall(a => cu.controller.get(a) == NOBODY and not(cu.always.contains(a))),
  }

  // States the simulation must reach, or `safety` proves little.
  val witnessActed = cu.acts > 0
  val witnessHeadedActed = cu.saidHeaded.exists(g => cu.controller.get(g._2) == g._1)
  val witnessInUse = sessions.exists(s => apps.exists(a => cu.turns.contains(s) and decision(s, a, false) == "in-use"))
  val witnessAlwaysRemoved = cu.acts > 0 and cu.always.size() == 0 and cu.saidApp.size() == 0
}
