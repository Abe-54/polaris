/**
 * User access (ENG-700, ADR 0099): the user gate in front of user-only RPCs and Commands
 * for token-less connections. Keys are small integers; the Host keeps the set it enrolled.
 * The real code is `transport/userAccess.ts` and the protocol's `userAccess.ts`.
 */
module user_access {
  pure val KEYS = Set(1, 2)
  pure val CONNECTIONS = 0.to(3)
  /** A connection's `hello` presented no key. */
  pure val NO_KEY = 0

  /** `Allowed`: which connection, and whether the request was user-only. */
  type Outcome = Nothing | HelloOk(bool) | Allowed((int, bool)) | Refused

  /** The enrolled keys' digests (`~/.polaris/user-access.json`). */
  var enrolled: Set[int]
  /** Connections whose `hello` presented an enrolled key; kept for the connection's life. */
  var held: Set[int]
  var last: Outcome

  action init = all { enrolled' = Set(), held' = Set(), last' = Nothing }

  // ── hello: the first key a Host sees is enrolled; an unknown later one is not ──
  action hello(c: int, k: int): bool = {
    val enrols = k != NO_KEY and enrolled == Set()
    val holds = held.contains(c) or enrols or (k != NO_KEY and enrolled.contains(k))
    all {
      enrolled' = if (enrols) Set(k) else enrolled,
      held' = if (holds) held.union(Set(c)) else held,
      last' = HelloOk(holds),
    }
  }

  // ── a request through the user gate: `user` needs held access, `any` never does ──
  action call(c: int, user: bool): bool = all {
    enrolled' = enrolled, held' = held,
    last' = if (user and not(held.contains(c))) Refused else Allowed((c, user)),
  }

  /** Recovery: the enrolment file deleted; live connections keep what they held. */
  action forget = all { enrolled' = Set(), held' = held, last' = Nothing }

  action step = {
    nondet c = CONNECTIONS.oneOf()
    nondet k = KEYS.union(Set(NO_KEY)).oneOf()
    nondet user = Set(true, false).oneOf()
    any { hello(c, k), call(c, user), forget }
  }

  // ── Safety ───────────────────────────────────────────────────────────────
  /** At most one key is enrolled at a time: nothing enrols beside an enrolled key. */
  val oneKey = enrolled.size() <= 1
  /** A user-only request is allowed only on a connection that holds user access. */
  val userOnlyNeedsAccess = match last {
    | Allowed(call) => call._2 implies held.contains(call._1)
    | _ => true
  }
  val safety = oneKey and userOnlyNeedsAccess

  val witnessRefused = last == Refused
}

module user_access_test {
  import user_access.* from "./user-access"

  run socketOnlyIsRefusedTest = init
    .then(hello(0, 1)).expect(last == HelloOk(true))
    .then(hello(1, NO_KEY)).expect(last == HelloOk(false))
    .then(call(1, true)).expect(last == Refused)
    .then(call(1, false)).expect(last == Allowed((1, false)))
    .then(call(0, true)).expect(last == Allowed((0, true)) and safety)

  run ownKeyIsNotEnrolledTest = init
    .then(hello(0, 1))
    .then(hello(1, 2)).expect(last == HelloOk(false) and enrolled == Set(1))
    .then(call(1, true)).expect(last == Refused and safety)

  run requestBeforeHelloIsRefusedTest = init
    .then(hello(0, 1))
    .then(call(2, true)).expect(last == Refused and safety)

  run forgetLetsTheNextKeyEnrolTest = init
    .then(hello(0, 1))
    .then(forget)
    .then(hello(1, 2)).expect(last == HelloOk(true) and enrolled == Set(2))
    .then(hello(2, 1)).expect(last == HelloOk(false) and safety)
}
