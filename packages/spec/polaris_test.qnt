// -*- mode: Bluespec; -*-
/**
 * Scenario tests for polaris.qnt (`quint test`). Each run is one interleaving
 * written out by hand; `safety` must hold after every step of it.
 */
module polaris_test {
  import polaris(
    HOST_FEED_GAPLESS = false,
    ARCHIVE_IGNORES_TURN = false,
    RECORDS_LATE_REQUESTS = false,
    CONTINUES_ACCEPTED = false,
    REVIEW_COMMANDS = true,
    USAGE_LIMITS = true,
    WORKSPACE_REMOVAL = false,
    FEED_DEFECT = "fails",
    CLIENTS = Set("mac", "phone"),
    SESSION_LIST = ["s1", "s2"],
    CMD_IDS = Set("k1", "k2", "k3", "k4"),
    REQUESTS = Set("r1", "r2"),
    REQUEST_SESSION = Map("r1" -> "s1", "r2" -> "s1"),
    CAPACITY = 2,
    MAX_LOG = 20,
    MAX_CRASHES = 2,
  ).* from "./polaris"

  pure val r1 = Respond({ session: "s1", req: "r1" })

  /** A Turn in s1 with its Harness running. */
  action turnRunning =
    init
      .then(clientSends("mac", "k1", SendTurn("s1")))
      .then(commitBatch)
      .then(publishBatch)
      .then(reactorRuns("s1"))

  run queuedUserInputAfterAutonomousEndTest =
    turnRunning
      .then(harnessReports("s1", HTurnEnded))
      .then(commitBatch).then(publishBatch)
      .then(harnessReports("s1", HTurnStarted))
      .then(commitBatch).then(publishBatch)
      .then(clientSends("mac", "k2", SendTurn("s1")))
      .then(commitBatch).then(publishBatch)
      .expect(answers.get("k2") == [Ok(0)] and safety)
      .then(clientSends("mac", "k3", SendTurn("s1")))
      .then(commitBatch).then(publishBatch)
      .expect(answers.get("k3") == [Ok(0)] and safety)
      .then(harnessReports("s1", HTurnEnded))
      .then(commitBatch).then(publishBatch)
      .then(harnessReports("s1", HUserTurnStarted))
      .then(commitBatch).then(publishBatch)
      .expect(viewOf(log, "s1").turns == 3 and not(viewOf(log, "s1").autonomous) and safety)
      .then(harnessReports("s1", HTurnEnded))
      .then(commitBatch).then(publishBatch)
      .then(harnessReports("s1", HUserTurnStarted))
      .then(commitBatch).then(publishBatch)
      .expect(viewOf(log, "s1").turns == 4 and not(viewOf(log, "s1").autonomous) and safety)

  run deferredInputRefusalAfterArchiveTest =
    turnRunning
      .then(harnessReports("s1", HTurnEnded))
      .then(commitBatch).then(publishBatch)
      .then(clientSends("mac", "k2", Archive("s1")))
      .then(commitBatch).then(publishBatch)
      .then(reactorRuns("s1"))
      // The refused prompt and its Error are durable items on the original Turn.
      .then(harnessReports("s1", HInputRefused))
      .then(commitBatch).then(publishBatch)
      .then(harnessReports("s1", HInputRefused))
      .then(commitBatch).then(publishBatch)
      .expect(viewOf(log, "s1").state == "archived" and viewOf(log, "s1").turns == 1 and safety)

  run deferredInputRefusalAfterFailureTest =
    turnRunning
      .then(harnessReports("s1", HTurnFailed))
      .then(commitBatch).then(publishBatch)
      .then(harnessReports("s1", HInputRefused))
      .then(commitBatch).then(publishBatch)
      .then(harnessReports("s1", HInputRefused))
      .then(commitBatch).then(publishBatch)
      .expect(viewOf(log, "s1").state == "failed" and viewOf(log, "s1").turns == 1 and safety)

  run steerRefusalKeepsWorkingTurnTest =
    turnRunning
      .then(harnessReports("s1", HInputRefused))
      .then(commitBatch).then(publishBatch)
      .then(harnessReports("s1", HInputRefused))
      .then(commitBatch).then(publishBatch)
      .expect(viewOf(log, "s1").state == "working" and viewOf(log, "s1").turns == 1 and safety)
      .then(harnessReports("s1", HTurnEnded))
      .then(commitBatch).then(publishBatch)
      .expect(viewOf(log, "s1").state == "idle" and safety)

  /** …that asked for approval r1: seq 3 ApprovalRequested, seq 4 Needs You. */
  action waitingOnApproval =
    turnRunning
      .then(harnessReports("s1", HRequest("r1")))
      .then(commitBatch)
      .then(publishBatch)
      .expect(viewOf(log, "s1").state == "needs-you" and safety)

  run groupCommitDecidesInOrderTest =
    init
      .then(clientSends("mac", "k1", SendTurn("s1")))
      .then(clientSends("phone", "k2", SendTurn("s1")))
      .then(clientRetries("k1"))
      .then(commitBatch)
      .then(publishBatch)
      // One batch: k1 wins, k2 is decided against k1's events, the retry is answered from the batch.
      .expect(all {
        answers.get("k1") == [Ok(2), Dup(2)],
        answers.get("k2") == [Rejected],
        log.length() == 2,
        safety,
      })

  run retryAfterCrashIsAnsweredFromTheReceiptTest =
    init
      .then(clientSends("mac", "k1", SendTurn("s1")))
      .then(commitBatch)
      // Committed, then the Daemon dies before anyone hears of it.
      .then(crash)
      .then(restart)
      .expect(all {
        answers.get("k1") == [],
        viewOf(log, "s1") == {
          turn: "interrupted",
          autonomous: false,
          state: "needs-you",
          pending: Set(),
          requested: [],
          turns: 1,
          archivedSinceTurn: false,
          accepted: 0,
          removed: false,
        },
        harness == Set(),
        safety,
      })
      .then(clientRetries("k1"))
      .then(commitBatch)
      .then(publishBatch)
      .expect(all { answers.get("k1") == [Dup(2)], log.length() == 4, reactor == Set(), safety })
      // Nothing continued on its own; the user does.
      .then(clientSends("mac", "k2", Continue("s1")))
      .then(commitBatch)
      .then(publishBatch)
      .then(reactorRuns("s1"))
      .expect(all { answers.get("k2") == [Ok(6)], harness == Set("s1"), safety })

  /** Retry only after a Failed Turn: a new Turn, and a restart leaves Failed alone. */
  run retrySendsAFailedTurnAgainTest =
    waitingOnApproval
      .then(clientSends("mac", "k2", Retry("s1")))
      .then(harnessReports("s1", HTurnFailed))
      .then(commitBatch)
      .then(publishBatch)
      .expect(all {
        answers.get("k2") == [Rejected],
        log[4].kind == ApprovalWithdrawn({ req: "r1", by: "harness" }),
        log[5].kind == TurnEnded("failed"),
        log[6].kind == StateChanged("failed"),
        safety,
      })
      .then(crash)
      .then(restart)
      .expect(all { log.length() == 7, viewOf(log, "s1").state == "failed", safety })
      .then(clientSends("phone", "k3", Retry("s1")))
      .then(commitBatch)
      .then(publishBatch)
      .then(reactorRuns("s1"))
      .expect(all {
        answers.get("k3") == [Ok(9)],
        viewOf(log, "s1").turns == 2,
        viewOf(log, "s1").state == "working",
        harness == Set("s1"),
        witnessRetried,
        safety,
      })

  /** A usage limit: the Turn is Interrupted, the session Limited; a restart leaves it, and Continue resumes it. */
  run aUsageLimitWaitsForContinueTest =
    waitingOnApproval
      .then(harnessReports("s1", HTurnLimited))
      .then(commitBatch)
      .then(publishBatch)
      .expect(all {
        log[4].kind == ApprovalWithdrawn({ req: "r1", by: "harness" }),
        log[5].kind == TurnEnded("interrupted"),
        log[6].kind == StateChanged("limited"),
        safety,
      })
      .then(crash)
      .then(restart)
      .expect(all { log.length() == 7, viewOf(log, "s1").state == "limited", safety })
      .then(clientSends("mac", "k2", Retry("s1")))
      .then(clientSends("phone", "k3", Continue("s1")))
      .then(commitBatch)
      .then(publishBatch)
      .then(reactorRuns("s1"))
      .expect(all {
        answers.get("k2") == [Rejected],
        answers.get("k3") == [Ok(9)],
        viewOf(log, "s1").turns == 1,
        viewOf(log, "s1").state == "working",
        harness == Set("s1"),
        witnessLimitContinued,
        safety,
      })

  run twoDevicesAnswerAtOnceTest =
    waitingOnApproval
      .then(clientSends("mac", "k2", r1))
      .then(clientSends("phone", "k3", r1))
      .then(commitBatch)
      .then(publishBatch)
      .expect(all {
        answers.get("k2") == [Ok(6)],
        answers.get("k3") == [Rejected],
        log[4].kind == ApprovalResolved({ req: "r1", by: "mac" }),
        viewOf(log, "s1").state == "working",
        safety,
      })

  run harnessWithdrawalBeforeTheAnswerTest =
    waitingOnApproval
      .then(harnessReports("s1", HWithdraw("r1")))
      .then(clientSends("phone", "k2", r1))
      .then(commitBatch)
      .then(publishBatch)
      .expect(all {
        log[4].kind == ApprovalWithdrawn({ req: "r1", by: "harness" }),
        answers.get("k2") == [Rejected],
        safety,
      })

  run secretRequestTimeoutTest =
    waitingOnApproval
      .then(harnessReports("s1", HExpire("r1")))
      .then(clientSends("phone", "k2", r1))
      .then(commitBatch)
      .then(publishBatch)
      .expect(all {
        log[4].kind == ApprovalWithdrawn({ req: "r1", by: "daemon" }),
        // The timeout closed the last request of a Turn in flight: back to work.
        viewOf(log, "s1").state == "working",
        answers.get("k2") == [Rejected],
        safety,
      })

  run answerBeforeTheHarnessWithdrawalTest =
    waitingOnApproval
      .then(clientSends("phone", "k2", r1))
      .then(harnessReports("s1", HWithdraw("r1")))
      .then(commitBatch)
      .then(publishBatch)
      .expect(all {
        log[4].kind == ApprovalResolved({ req: "r1", by: "phone" }),
        // The withdrawal found nothing pending and recorded nothing.
        log.length() == 6,
        answers.get("k2") == [Ok(6)],
        safety,
      })

  run restartWithdrawsAndInterruptsTest =
    waitingOnApproval
      .then(crash)
      .then(restart)
      .expect(all {
        log[4].kind == TurnEnded("interrupted"),
        log[5].kind == ApprovalWithdrawn({ req: "r1", by: "daemon" }),
        log[6].kind == StateChanged("needs-you"),
        harness == Set(),
        safety,
      })
      // A late answer from a Client that had not heard is rejected.
      .then(clientSends("phone", "k2", r1))
      .then(commitBatch)
      .then(publishBatch)
      .expect(answers.get("k2") == [Rejected] and safety)

  run slowSubscriberIsDroppedAndResumesWithoutGapsTest =
    init
      .then(clientSends("mac", "k1", SendTurn("s1")))
      .then(commitBatch)
      .then(publishBatch)
      .then(subscribe("phone", "s1"))
      .then(readCut("phone", "s1"))
      .then(reactorRuns("s1"))
      .then(3.reps(_ => harnessReports("s1", HItem).then(commitBatch).then(publishBatch)))
      .expect(subs.get(("phone", "s1")).dropped and safety)
      // Snapshot, Synchronized, then the two buffered events; the stream then ends.
      .then(4.reps(_ => deliver("phone", "s1")))
      .then(streamEnds("phone", "s1"))
      .then(subscribe("phone", "s1"))
      .then(readCut("phone", "s1"))
      // Replays (4, 5], then Synchronized.
      .then(2.reps(_ => deliver("phone", "s1")))
      .expect(all {
        feeds.get(("phone", "s1")).seen == streamSeqs(log, "s1"),
        safety,
      })

  run hostFeedSkipsSessionOnlyEventsTest =
    init
      .then(subscribe("mac", HOST))
      .then(readCut("mac", HOST))
      .then(2.reps(_ => deliver("mac", HOST)))
      .then(clientSends("mac", "k1", SendTurn("s1")))
      .then(commitBatch)
      .then(publishBatch)
      .then(2.reps(_ => deliver("mac", HOST)))
      .then(reactorRuns("s1"))
      .then(harnessReports("s1", HItem))
      .then(harnessReports("s1", HTurnEnded))
      .then(commitBatch)
      .then(publishBatch)
      .then(2.reps(_ => deliver("mac", HOST)))
      // Without the gap check the host feed sees 1, 2, 4, 5: seq 3 is an ItemCompleted.
      .expect(feeds.get(("mac", HOST)).seen == [1, 2, 4, 5] and hostFeedCanProgress and safety)

  /** ENG-492: a defect on a stream's upstream fails the feed visibly; it never resubscribes. */
  run upstreamDefectFailsTheFeedTest =
    init
      .then(clientSends("mac", "k1", SendTurn("s1")))
      .then(commitBatch)
      .then(publishBatch)
      .then(subscribe("phone", "s1"))
      .then(readCut("phone", "s1"))
      .then(2.reps(_ => deliver("phone", "s1")))
      .then(upstreamDefect("phone", "s1"))
      .expect(all {
        feeds.get(("phone", "s1")).failed,
        subs.get(("phone", "s1")).phase == "closed",
        feedsFailVisibly,
        safety,
      })
      .expect(not(canSubscribe("phone", "s1")))
      .then(crash)
      .then(restart)
      .expect(not(canSubscribe("phone", "s1")))
      // The device's other feeds carry on.
      .then(subscribe("phone", "s2"))
      .expect(subs.get(("phone", "s2")).phase == "registered" and safety)

  /** Finding 2: Archive waits for the Turn in flight (and its request) to end. */
  run archiveIsRefusedWithATurnInFlightTest =
    waitingOnApproval
      .then(clientSends("mac", "k2", Archive("s1")))
      .then(commitBatch)
      .then(publishBatch)
      .expect(all { answers.get("k2") == [Rejected], viewOf(log, "s1").state == "needs-you", safety })
      .then(harnessReports("s1", HTurnEnded))
      .then(commitBatch)
      .then(publishBatch)
      .then(clientSends("mac", "k3", Archive("s1")))
      .then(commitBatch)
      .then(publishBatch)
      .then(reactorRuns("s1"))
      .expect(all {
        answers.get("k3") == [Ok(8)],
        viewOf(log, "s1").state == "archived",
        viewOf(log, "s1").pending == Set(),
        // Archive stopped the Harness.
        harness == Set(),
        safety,
      })
      // A Turn is refused until Unarchive; a restart leaves the session Archived.
      .then(clientSends("mac", "k4", SendTurn("s1")))
      .then(commitBatch)
      .then(publishBatch)
      .then(crash)
      .then(restart)
      .expect(all { answers.get("k4") == [Rejected], viewOf(log, "s1").state == "archived", log.length() == 8, safety })

  run unarchiveThenANewTurnTest =
    turnRunning
      .then(harnessReports("s1", HTurnEnded))
      .then(commitBatch)
      .then(publishBatch)
      .then(clientSends("mac", "k2", Archive("s1")))
      .then(clientSends("phone", "k3", Unarchive("s1")))
      .then(clientSends("mac", "k4", SendTurn("s1")))
      .then(commitBatch)
      .then(publishBatch)
      .then(reactorRuns("s1"))
      .expect(all {
        answers.get("k2") == [Ok(5)],
        answers.get("k3") == [Ok(6)],
        answers.get("k4") == [Ok(8)],
        viewOf(log, "s1").state == "working",
        harness == Set("s1"),
        safety,
      })

  /** Finding 3: a request the Harness sends after its Turn ended is not recorded. */
  run lateRequestIsIgnoredTest =
    turnRunning
      .then(harnessReports("s1", HTurnEnded))
      .then(commitBatch)
      .then(publishBatch)
      .then(harnessReports("s1", HRequest("r1")))
      .expect(witnessLateRequest)
      // Decided: nothing to record, so nothing to publish.
      .then(commitBatch)
      .expect(all { log.length() == 4, toPublish == [], viewOf(log, "s1").state == "idle", safety })
      .then(clientSends("mac", "k2", SendTurn("s1")))
      .then(commitBatch)
      .then(publishBatch)
      .expect(answers.get("k2") == [Ok(6)] and safety)

  /** …and one reported during the Turn but decided after a later Turn started is not either. */
  run requestForAnEarlierTurnIsIgnoredTest =
    turnRunning
      // In one batch: Turn 1 ends, a Client starts Turn 2, then Turn 1's request is decided.
      .then(harnessReports("s1", HTurnEnded))
      .then(clientSends("mac", "k2", SendTurn("s1")))
      .then(harnessReports("s1", HRequest("r1")))
      .then(commitBatch)
      .then(publishBatch)
      .expect(all {
        answers.get("k2") == [Ok(6)],
        log.length() == 6,
        viewOf(log, "s1").turn == "working",
        viewOf(log, "s1").pending == Set(),
        safety,
      })
      // A request reported during a Turn and decided before it ends is recorded, and the end withdraws it.
      .then(harnessReports("s1", HRequest("r2")))
      .then(harnessReports("s1", HTurnEnded))
      .then(commitBatch)
      .then(publishBatch)
      .expect(all {
        log[6].kind == ApprovalRequested("r2"),
        log[8].kind == ApprovalWithdrawn({ req: "r2", by: "harness" }),
        viewOf(log, "s1").pending == Set(),
        safety,
      })

  /** s1's first Turn completed and its Harness running. */
  action turnCompleted =
    turnRunning
      .then(harnessReports("s1", HTurnEnded))
      .then(commitBatch)
      .then(publishBatch)

  run acceptTurnsTest =
    turnRunning
      // Not while the Turn is in flight.
      .then(clientSends("mac", "k2", AcceptTurns({ session: "s1", through: 1 })))
      .then(commitBatch)
      .then(publishBatch)
      .expect(answers.get("k2") == [Rejected])
      .then(harnessReports("s1", HTurnEnded))
      .then(commitBatch)
      .then(publishBatch)
      // A Turn that doesn't exist yet is refused; the one that does is accepted, once.
      .then(clientSends("mac", "k3", AcceptTurns({ session: "s1", through: 2 })))
      .then(clientSends("phone", "k4", AcceptTurns({ session: "s1", through: 1 })))
      .then(commitBatch)
      .then(publishBatch)
      .expect(all {
        answers.get("k3") == [Rejected],
        answers.get("k4") == [Ok(log.length())],
        viewOf(log, "s1").accepted == 1,
        log[log.length() - 1].kind == TurnsAccepted(1),
        safety,
      })

  run acceptingMovesForwardTest =
    turnCompleted
      .then(clientSends("mac", "k2", AcceptTurns({ session: "s1", through: 1 })))
      .then(clientSends("mac", "k3", SendTurn("s1")))
      .then(commitBatch)
      .then(publishBatch)
      .then(reactorRuns("s1"))
      .then(harnessReports("s1", HTurnEnded))
      .then(commitBatch)
      .then(publishBatch)
      .then(clientSends("phone", "k4", AcceptTurns({ session: "s1", through: 2 })))
      .then(commitBatch)
      .then(publishBatch)
      .expect(all {
        viewOf(log, "s1").accepted == 2,
        log.indices().filter(i => match log[i].kind { | TurnsAccepted(_) => true | _ => false }).size() == 2,
        acceptedOnlyForward,
        safety,
      })

  run verdictsStayOffTheHostStreamTest =
    turnCompleted
      .then(clientSends("mac", "k2", RecordVerdict))
      .then(commitBatch)
      .then(publishBatch)
      .then(subscribe("phone", HOST))
      .then(readCut("phone", HOST))
      .then(deliver("phone", HOST))
      .expect(all {
        log[log.length() - 1].kind == ReviewRecorded,
        streamSeqs(log, HOST).select(x => x == log.length()).length() == 0,
        streamSeqs(log, "s1").select(x => x == log.length()).length() == 0,
        safety,
      })

  run acceptedInterruptedTurnIsNotContinuedTest =
    turnRunning
      .then(crash)
      .then(restart)
      .expect(viewOf(log, "s1").turn == "interrupted")
      .then(clientSends("mac", "k2", AcceptTurns({ session: "s1", through: 1 })))
      .then(commitBatch)
      .then(publishBatch)
      .then(clientSends("mac", "k3", Continue("s1")))
      .then(commitBatch)
      .then(publishBatch)
      .expect(all { answers.get("k3") == [Rejected], acceptedNeverInFlight, safety })
  run promptDuringAutonomousTurnSteersTest =
    init
      .then(clientSends("mac", "k1", SendTurn("s1")))
      .then(commitBatch)
      .then(publishBatch)
      .then(reactorRuns("s1"))
      .then(harnessReports("s1", HTurnEnded))
      .then(commitBatch)
      .then(publishBatch)
      .then(harnessReports("s1", HTurnStarted))
      .then(commitBatch)
      .then(publishBatch)
      .then(clientSends("mac", "k2", SendTurn("s1")))
      .then(commitBatch)
      .then(publishBatch)
      .expect(all { answers.get("k2") == [Ok(0)], viewOf(log, "s1").turns == 2, viewOf(log, "s1").state == "working", safety })

  run backgroundReportStartsFreshTurnTest =
    turnRunning
      .then(harnessReports("s1", HTurnEnded)).then(commitBatch).then(publishBatch)
      .then(harnessReports("s1", HTurnStarted)).then(commitBatch).then(publishBatch)
      .expect(viewOf(log, "s1").turns == 2 and viewOf(log, "s1").state == "working" and safety)
      .then(harnessReports("s1", HTurnEnded)).then(commitBatch).then(publishBatch)
      .expect(viewOf(log, "s1").state == "idle" and safety)

  /** ADR 0086: a Workspace with a session that isn't Archived is not removed. */
  run removalWaitsForEverySessionTest =
    init
      .then(clientSends("mac", "k1", Archive("s1")))
      .then(clientSends("mac", "k2", RemoveWorkspace))
      .then(commitBatch)
      .then(publishBatch)
      .expect(all {
        answers.get("k1") == [Ok(1)],
        answers.get("k2") == [Rejected],
        not(viewOf(log, "s2").removed),
        safety,
      })

  /**
   * ADR 0086: removal purges every session; the log keeps their events, nothing reaches
   * them again (Unarchive is NotFound), and a restart recovers nothing for them.
   */
  run removalPurgesAndIsFinalTest =
    init
      .then(clientSends("mac", "k1", Archive("s1")))
      .then(clientSends("mac", "k2", Archive("s2")))
      .then(clientSends("phone", "k3", RemoveWorkspace))
      .then(commitBatch)
      .then(publishBatch)
      .expect(all {
        answers.get("k3") == [Ok(3)],
        log[2] == { seq: 3, session: HOST, cmd: "k3", kind: WorkspaceRemoved },
        SESSIONS.forall(s => viewOf(log, s).removed),
        safety,
      })
      .then(clientSends("mac", "k4", Unarchive("s1")))
      .then(commitBatch)
      .then(publishBatch)
      .then(crash)
      .then(restart)
      .expect(all { answers.get("k4") == [Rejected], log.length() == 3, safety })
}

/** Finding 1: the host feed with the gap check `HostConnection` used before the fix. */
module polaris_finding1_test {
  import polaris(
    HOST_FEED_GAPLESS = true,
    ARCHIVE_IGNORES_TURN = false,
    RECORDS_LATE_REQUESTS = false,
    CONTINUES_ACCEPTED = false,
    REVIEW_COMMANDS = true,
    USAGE_LIMITS = true,
    WORKSPACE_REMOVAL = false,
    FEED_DEFECT = "none",
    CLIENTS = Set("mac", "phone"),
    SESSION_LIST = ["s1", "s2"],
    CMD_IDS = Set("k1", "k2", "k3", "k4"),
    REQUESTS = Set("r1", "r2"),
    REQUEST_SESSION = Map("r1" -> "s1", "r2" -> "s1"),
    CAPACITY = 2,
    MAX_LOG = 10,
    MAX_CRASHES = 2,
  ).* from "./polaris"

  run hostFeedGetsStuckOnASessionOnlyEventTest =
    init
      .then(subscribe("mac", HOST))
      .then(readCut("mac", HOST))
      .then(2.reps(_ => deliver("mac", HOST)))
      .then(clientSends("mac", "k1", SendTurn("s1")))
      .then(commitBatch)
      .then(publishBatch)
      .then(2.reps(_ => deliver("mac", HOST)))
      .then(reactorRuns("s1"))
      .then(harnessReports("s1", HItem))
      .then(harnessReports("s1", HTurnEnded))
      .then(commitBatch)
      .then(publishBatch)
      // seq 4 after 2: a gap, so the feed reopens from 2…
      .then(deliver("mac", HOST))
      .expect(subs.get(("mac", HOST)).phase == "closed" and feeds.get(("mac", HOST)).last == 2)
      // …the replay of (2, 5] starts at 4 again, and so on forever.
      .then(subscribe("mac", HOST))
      .then(readCut("mac", HOST))
      .then(deliver("mac", HOST))
      .expect(all {
        subs.get(("mac", HOST)).phase == "closed",
        feeds.get(("mac", HOST)).last == 2,
        not(hostFeedCanProgress),
        feedsAreCommittedPrefixes,
      })
}

/** Finding 5 (ENG-492): an upstream defect ended the pump and left the feed open and silent. */
module polaris_finding5_test {
  import polaris(
    HOST_FEED_GAPLESS = false,
    ARCHIVE_IGNORES_TURN = false,
    RECORDS_LATE_REQUESTS = false,
    CONTINUES_ACCEPTED = false,
    REVIEW_COMMANDS = true,
    USAGE_LIMITS = true,
    WORKSPACE_REMOVAL = false,
    FEED_DEFECT = "freezes",
    CLIENTS = Set("mac", "phone"),
    SESSION_LIST = ["s1", "s2"],
    CMD_IDS = Set("k1", "k2", "k3", "k4"),
    REQUESTS = Set("r1", "r2"),
    REQUEST_SESSION = Map("r1" -> "s1", "r2" -> "s1"),
    CAPACITY = 2,
    MAX_LOG = 10,
    MAX_CRASHES = 2,
  ).* from "./polaris"

  run upstreamDefectFreezesTheFeedTest =
    init
      .then(subscribe("phone", "s1"))
      .then(readCut("phone", "s1"))
      .then(upstreamDefect("phone", "s1"))
      .then(clientSends("mac", "k1", SendTurn("s1")))
      .then(commitBatch)
      .then(publishBatch)
      // Nothing more reaches the feed, and it neither fails nor reopens.
      .expect(all {
        subs.get(("phone", "s1")).phase == "frozen",
        not(canSubscribe("phone", "s1")),
        not(feeds.get(("phone", "s1")).failed),
        not(feedsFailVisibly),
        feedsAreCommittedPrefixes,
      })
}

/** Finding 2: Archive accepted with a Turn in flight, as In Terminal and Starting did. */
module polaris_finding2_test {
  import polaris(
    HOST_FEED_GAPLESS = false,
    ARCHIVE_IGNORES_TURN = true,
    RECORDS_LATE_REQUESTS = false,
    CONTINUES_ACCEPTED = false,
    REVIEW_COMMANDS = true,
    USAGE_LIMITS = true,
    WORKSPACE_REMOVAL = false,
    FEED_DEFECT = "none",
    CLIENTS = Set("mac", "phone"),
    SESSION_LIST = ["s1", "s2"],
    CMD_IDS = Set("k1", "k2", "k3", "k4"),
    REQUESTS = Set("r1", "r2"),
    REQUEST_SESSION = Map("r1" -> "s1", "r2" -> "s1"),
    CAPACITY = 2,
    MAX_LOG = 10,
    MAX_CRASHES = 2,
  ).* from "./polaris"

  run archiveMidTurnLeavesItOpenTest =
    init
      .then(clientSends("mac", "k1", SendTurn("s1")))
      .then(commitBatch)
      .then(publishBatch)
      .then(reactorRuns("s1"))
      .then(harnessReports("s1", HRequest("r1")))
      .then(commitBatch)
      .then(publishBatch)
      .then(clientSends("mac", "k2", Archive("s1")))
      .then(commitBatch)
      .then(publishBatch)
      .expect(all {
        viewOf(log, "s1") == {
          turn: "working",
          autonomous: false,
          state: "archived",
          pending: Set("r1"),
          requested: ["r1"],
          turns: 1,
          archivedSinceTurn: true,
          accepted: 0,
          removed: false,
        },
        not(archivedIsClosed),
      })
}

/** Finding 3: late approval requests recorded. */
module polaris_finding3_test {
  import polaris(
    HOST_FEED_GAPLESS = false,
    ARCHIVE_IGNORES_TURN = false,
    RECORDS_LATE_REQUESTS = true,
    CONTINUES_ACCEPTED = false,
    REVIEW_COMMANDS = true,
    USAGE_LIMITS = true,
    WORKSPACE_REMOVAL = false,
    FEED_DEFECT = "none",
    CLIENTS = Set("mac", "phone"),
    SESSION_LIST = ["s1", "s2"],
    CMD_IDS = Set("k1", "k2", "k3", "k4"),
    REQUESTS = Set("r1", "r2"),
    REQUEST_SESSION = Map("r1" -> "s1", "r2" -> "s1"),
    CAPACITY = 2,
    MAX_LOG = 10,
    MAX_CRASHES = 2,
  ).* from "./polaris"

  run lateRequestLeavesWorkingWithNoTurnTest =
    init
      .then(clientSends("mac", "k1", SendTurn("s1")))
      .then(commitBatch)
      .then(publishBatch)
      .then(reactorRuns("s1"))
      .then(harnessReports("s1", HTurnEnded))
      .then(commitBatch)
      .then(publishBatch)
      .then(harnessReports("s1", HRequest("r1")))
      .then(commitBatch)
      .then(publishBatch)
      .expect(viewOf(log, "s1").state == "needs-you" and not(approvalsNeedATurn))
      // Answering it moves the session Working with no Turn…
      .then(clientSends("mac", "k2", Respond({ session: "s1", req: "r1" })))
      .then(commitBatch)
      .then(publishBatch)
      .expect(all {
        viewOf(log, "s1").state == "working",
        viewOf(log, "s1").turn == "completed",
        not(workingHasATurn),
      })
      // …and a new Turn is refused.
      .then(clientSends("mac", "k3", SendTurn("s1")))
      .then(commitBatch)
      .then(publishBatch)
      .expect(answers.get("k3") == [Rejected])
}

/** Finding 4: Continue reopened an accepted Interrupted Turn. */
module polaris_finding4_test {
  import polaris(
    HOST_FEED_GAPLESS = false,
    ARCHIVE_IGNORES_TURN = false,
    RECORDS_LATE_REQUESTS = false,
    CONTINUES_ACCEPTED = true,
    REVIEW_COMMANDS = true,
    USAGE_LIMITS = true,
    WORKSPACE_REMOVAL = false,
    FEED_DEFECT = "none",
    CLIENTS = Set("mac", "phone"),
    SESSION_LIST = ["s1", "s2"],
    CMD_IDS = Set("k1", "k2", "k3", "k4"),
    REQUESTS = Set("r1", "r2"),
    REQUEST_SESSION = Map("r1" -> "s1", "r2" -> "s1"),
    CAPACITY = 2,
    MAX_LOG = 10,
    MAX_CRASHES = 2,
  ).* from "./polaris"

  run continueReopensAnAcceptedTurnTest =
    init
      .then(clientSends("mac", "k1", SendTurn("s1")))
      .then(commitBatch)
      .then(publishBatch)
      .then(crash)
      .then(restart)
      .then(clientSends("mac", "k2", AcceptTurns({ session: "s1", through: 1 })))
      .then(commitBatch)
      .then(publishBatch)
      .then(clientSends("mac", "k3", Continue("s1")))
      .then(commitBatch)
      .then(publishBatch)
      .expect(all { viewOf(log, "s1").turn == "working", not(acceptedNeverInFlight) })


}
