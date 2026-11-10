import { expect, test } from "bun:test";
import { deriveStats } from "./derive.ts";
import { pricedStats } from "./cli.ts";
import { time, statsFixture } from "./stats.testing.ts";
import {
  DomainEvent,
  HostId,
  Constellation,
  Attempt,
  AttemptCause,
  AttemptId,
} from "@polaris/protocol";
import { CID } from "../../engine/constellation.testing.ts";
import { graphData, attemptData } from "../data.ts";

test("digest, review, reused worker sessions and overlapping FIFO waits have independently expected totals", () => {
  const { history, responses } = statsFixture();
  const stats = deriveStats(history, responses, Date.parse(time(15000)));
  expect(stats.wallClockMs).toBe(15000);
  expect(stats.lead).toMatchObject({
    wakeups: 2,
    deliveredItems: 4,
    coalescedItems: 2,
    coalescingHitRate: 0.5,
    meanTokensPerDigest: 200,
    meanReportedUsdPerDigest: 0.1,
  });
  expect(stats.review).toMatchObject({
    decidedClaims: 1,
    meanClaimToReviewMs: 4000,
    medianClaimToReviewMs: 4000,
    acceptedFirstTime: 1,
    firstClaimsReviewed: 1,
    firstTimeAcceptanceRate: 1,
  });
  expect(stats.workers.attempts[0]?.times).toEqual({
    workingMs: 2000,
    idleMs: 2000,
    waitingForSlotMs: 1000,
    waitingOnLeaseMs: 2000,
    staleMs: 0,
  });
  expect(stats.workers.attempts[1]?.times).toEqual({
    workingMs: 3000,
    idleMs: 2000,
    waitingForSlotMs: 2000,
    waitingOnLeaseMs: 0,
    staleMs: 0,
  });
  expect(stats.usage.perTask.map((t) => t.usage.tokens.input)).toEqual([50, 70]);
  expect(stats.usage.perRole.map((r) => r.usage.tokens.input)).toEqual([600, 120]);
  expect(stats.usage.total.tokens.input).toBe(720);
  expect(stats.usage.total.reportedUsd).toBeCloseTo(0.3);
  expect(stats.coverage.some((c) => c.metric === "workers.staleMs")).toBe(true);
});

test("open intervals advance when viewed while cached revision totals stay reusable", () => {
  const { history, responses } = statsFixture();
  const first = deriveStats(history, responses, Date.parse(time(15000)));
  const second = deriveStats(history, responses, Date.parse(time(16000)), first);
  expect(second.review).toEqual(first.review);
  expect(second.usage).toEqual(first.usage);
  expect(second.lead).toEqual(first.lead);
  expect(second.workers.attempts[1]?.times.workingMs).toBe(4000);
  expect(second.wallClockMs).toBe(16000);
});

test("CLI keeps reported costs and explicitly leaves unknown model tokens unpriced", () => {
  const { history, responses } = statsFixture();
  const priced = pricedStats(deriveStats(history, responses, Date.parse(time(15000))));
  expect(priced.pricing).toMatchObject({ kind: "api-equivalent-estimate", source: "bundled" });
  expect(priced.cost.total.usd).toBeCloseTo(0.3);
  expect(priced.cost.total.unpricedTokens).toBe(570);
  expect(priced.cost.perDigest[0]?.cost.reportedUsd).toBe(0.2);
});

test("approval closes review latency before merge, and completion stops wall clock before archive", () => {
  const { history, responses, envelope, first } = statsFixture();

  const events = [
    ...history.events,
    envelope(
      6000,
      DomainEvent.cases.ClaimApproved.make({
        constellationId: CID,
        revision: 2,
        attemptId: first.id,
        attemptRevision: 2,
        by: "user",
        at: time(6000),
      })
    ),
    envelope(
      14000,
      DomainEvent.cases.ConstellationStateChanged.make({
        constellationId: CID,
        revision: 8,
        state: "completed",
      })
    ),
    envelope(
      18000,
      DomainEvent.cases.ConstellationStateChanged.make({
        constellationId: CID,
        revision: 9,
        state: "archived",
      })
    ),
  ].toSorted((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  const stats = deriveStats({ ...history, events }, responses, Date.parse(time(20000)));
  expect(stats.review.meanClaimToReviewMs).toBe(1000);
  expect(stats.review.decidedClaims).toBe(1);
  expect(stats.review.firstTimeAcceptanceRate).toBe(1);
  expect(stats.wallClockMs).toBe(14000);
});

test("missing digest and remote worker history expose unknown coverage rather than zero durations", () => {
  const { history, responses, second } = statsFixture();
  const remote = Attempt.make({ ...attemptData(second), hostId: HostId.make("remote") });

  const graph = Constellation.make({
    ...graphData(history.graph),
    attempts: [history.graph.attempts[0]!, remote],
  });

  const stats = deriveStats(
    { ...history, graph, sessions: new Map() },
    { ...responses, indexing: true },
    Date.parse(time(15000))
  );

  expect(stats.lead.meanTokensPerDigest).toBeNull();
  expect(stats.lead.meanReportedUsdPerDigest).toBeNull();
  expect(stats.workers.attempts[1]?.times).toEqual({
    workingMs: null,
    idleMs: null,
    waitingForSlotMs: null,
    waitingOnLeaseMs: null,
    staleMs: 0,
  });
  expect(stats.coverage.map((c) => c.metric)).toContain("lead.digests");
  expect(stats.coverage.filter((c) => c.metric === "usage")).toHaveLength(2);
  expect(pricedStats(stats).cost.meanUsdPerDigest).toBeNull();
});

test("send-backs are grouped by retry cause rather than counting recovery or initial Attempts", () => {
  const { history, responses, second } = statsFixture();

  const sentBack = Attempt.make({
    ...attemptData(second),
    cause: AttemptCause.cases.SentBack.make({
      ref: history.graph.attempts[0]!.id,
    }),
  });

  const recovered = Attempt.make({
    ...attemptData(second),
    id: AttemptId.make("b2"),
    cause: AttemptCause.cases.Recover.make({ ref: sentBack.id }),
  });

  const graph = Constellation.make({
    ...graphData(history.graph),
    attempts: [history.graph.attempts[0]!, sentBack, recovered],
  });

  expect(
    deriveStats({ ...history, graph }, responses, Date.parse(time(15000))).review.sendBacksByCause
  ).toEqual([{ cause: "SentBack", count: 1 }]);
});

test("owner event.at drives stale time through review and remote open intervals across reused Sessions", () => {
  const { history, responses, envelope, first, second } = statsFixture();

  const graph = Constellation.make({
    ...graphData(history.graph),
    attempts: [first, Attempt.make({ ...attemptData(second), hostId: HostId.make("remote") })],
  });

  const events = [
    ...history.events,
    envelope(
      7000,
      DomainEvent.cases.AttemptStale.make({
        constellationId: CID,
        revision: graph.revision,
        attemptId: first.id,
        hostId: first.hostId,
        at: time(6000),
      })
    ),
    envelope(
      13000,
      DomainEvent.cases.AttemptFresh.make({
        constellationId: CID,
        revision: graph.revision,
        attemptId: first.id,
        at: time(8000),
      })
    ),
    envelope(
      14000,
      DomainEvent.cases.AttemptStale.make({
        constellationId: CID,
        revision: graph.revision,
        attemptId: second.id,
        hostId: HostId.make("remote"),
        at: time(11000),
      })
    ),
  ].toSorted((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  const source = { ...history, graph, events };
  const stats = deriveStats(source, responses, Date.parse(time(15000)));
  expect(stats.workers.attempts.map((a) => a.times.staleMs)).toEqual([2000, 4000]);
  expect(stats.workers.totals.staleMs).toBe(6000);
  expect(stats.workers.attempts[1]?.times.workingMs).toBeNull();

  const replayed = deriveStats(
    { ...source, events: [...events] },
    responses,
    Date.parse(time(16000)),
    stats
  );

  expect(replayed.workers.attempts.map((a) => a.times.staleMs)).toEqual([2000, 5000]);
  expect(replayed.revision).toBe(stats.revision);

  const resumed = [
    ...events,
    envelope(
      17000,
      DomainEvent.cases.AttemptFresh.make({
        constellationId: CID,
        revision: graph.revision,
        attemptId: second.id,
        at: time(16000),
      })
    ),
  ];

  const fresh = deriveStats(
    { ...source, events: resumed },
    responses,
    Date.parse(time(18000)),
    stats
  );

  expect(fresh.workers.totals.staleMs).toBe(7000);
});

test("a stale observation cannot accrue after a terminal Attempt end", () => {
  const { history, responses, envelope, first } = statsFixture();

  const events = [
    ...history.events,
    envelope(
      10000,
      DomainEvent.cases.AttemptStale.make({
        constellationId: CID,
        revision: history.graph.revision,
        attemptId: first.id,
        hostId: first.hostId,
        at: time(8000),
      })
    ),
  ];

  expect(
    deriveStats({ ...history, events }, responses, Date.parse(time(15000))).workers.attempts[0]
      ?.times.staleMs
  ).toBe(1000);
});
