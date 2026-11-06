/**
 * Compatibility of the persisted and streamed contract: events already in a
 * Host's log must keep decoding, and additions must be additive.
 */
import { describe, expect, test } from "bun:test";
import { Predicate, Schema } from "effect";
import { HarnessAvailability, HostHarnesses } from "./availability.ts";
import { CapabilityList } from "./capabilities.ts";
import { Command } from "./commands.ts";
import { ApprovalDecision, TurnItem } from "./domain.ts";
import { DomainEvent } from "./events.ts";
import { HARNESS_CATALOGUE, harnessEntry } from "./harnesses.ts";
import { RequestId, Sequence, SessionId, TurnId } from "./ids.ts";
import { SessionStreamItem, TurnDetail } from "./rpc.ts";
import { UsageBucket, UsageReport, UsageStreamItem } from "./usage.ts";

/** Decodes a log row or wire message exactly as it was written, as JSON text. */
const decodeEventJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(DomainEvent))
);

const decodeItemJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(SessionStreamItem))
);

describe("contract compatibility", () => {
  test("a withdrawal logged before ApprovalWithdrawn existed still decodes", () => {
    const legacy =
      '{"_tag":"ApprovalResolved","sessionId":"s","requestId":"r",' +
      '"decision":{"_tag":"Deny","reason":"Withdrawn by the Harness"},"resolvedBy":"Harness"}';

    expect(decodeEventJson(legacy)).toEqual(
      DomainEvent.cases.ApprovalResolved.make({
        sessionId: SessionId.make("s"),
        requestId: RequestId.make("r"),
        decision: ApprovalDecision.cases.Deny.make({ reason: "Withdrawn by the Harness" }),
        resolvedBy: "Harness",
      })
    );
  });

  test("reasoning, plans and sessions logged before their meta fields decode with them null", () => {
    const reasoning =
      '{"_tag":"TurnItemCompleted","sessionId":"s","turnId":"t",' +
      '"item":{"_tag":"Reasoning","id":"r","text":"Hmm"}}';

    const plan =
      '{"_tag":"TurnItemCompleted","sessionId":"s","turnId":"t",' +
      '"item":{"_tag":"Plan","id":"p","steps":[{"text":"a","status":"pending"}]}}';

    expect(decodeEventJson(reasoning)).toMatchObject({
      item: TurnItem.cases.Reasoning.make({ id: "r", text: "Hmm", startedAt: null, endedAt: null }),
    });
    expect(decodeEventJson(plan)).toMatchObject({
      item: TurnItem.cases.Plan.make({
        id: "p",
        steps: [{ text: "a", status: "pending", detail: null }],
        explanation: null,
      }),
    });
  });

  test("ItemProgress carries a full item; a Snapshot with unknown extra fields still decodes", () => {
    expect(
      decodeItemJson(
        '{"_tag":"ItemProgress","turnId":"t",' +
          '"item":{"_tag":"Plan","id":"p","steps":[{"text":"a","status":"in-progress"}]}}'
      )
    ).toEqual(
      SessionStreamItem.cases.ItemProgress.make({
        turnId: TurnId.make("t"),
        item: TurnItem.cases.Plan.make({
          id: "p",
          steps: [{ text: "a", status: "in-progress", detail: null }],
          explanation: null,
        }),
        subagentId: null,
      })
    );
    expect(decodeItemJson('{"_tag":"Synchronized","sequence":3,"somethingNewer":true}')).toEqual(
      SessionStreamItem.cases.Synchronized.make({ sequence: Sequence.make(3) })
    );
  });

  const legacySession =
    '{"id":"s","workspaceId":"w","harness":"claude","title":"t","cwd":"/repo","worktreeId":null,' +
    '"state":"idle","permissionMode":"supervised","model":"opus","parentSessionId":null,' +
    '"forkedFromTurnId":null,"harnessCursor":null,"turnCount":1,"lastError":null,' +
    '"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}';

  const legacyTurn =
    '{"id":"t","sessionId":"s","index":0,"prompt":"hi","attachments":[],"status":"completed",' +
    '"checkpointBefore":null,"checkpointAfter":null,' +
    '"startedAt":"2026-01-01T00:00:00Z","endedAt":"2026-01-01T00:01:00Z"}';

  test("sessions and Turns logged before Model per Turn decode with no effort and no Model", () => {
    const created = decodeEventJson(`{"_tag":"SessionCreated","session":${legacySession}}`);
    const started = decodeEventJson(`{"_tag":"TurnStarted","turn":${legacyTurn}}`);

    expect(Predicate.isTagged(created, "SessionCreated") && created.session).toMatchObject({
      model: "opus",
      effort: null,
      contextUsage: null,
      backgroundTasks: [],
    });
    expect(Predicate.isTagged(started, "TurnStarted") && started.turn).toMatchObject({
      model: null,
      effort: null,
      trigger: null,
    });
  });

  test("a session of a Harness this build doesn't list still decodes", () => {
    const newer = legacySession.replace('"harness":"claude"', '"harness":"kimi"');
    const event = decodeEventJson(`{"_tag":"SessionCreated","session":${newer}}`);

    expect(Predicate.isTagged(event, "SessionCreated") && event.session.harness).toBe("kimi");
    expect(harnessEntry("kimi")).toBeUndefined();
    expect(() =>
      decodeEventJson(
        `{"_tag":"SessionCreated","session":${legacySession.replace('"claude"', '"Not A Kind"')}}`
      )
    ).toThrow();
  });

  test("commands from Clients that predate effort and origin still decode", () => {
    const decodeCommand = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.toCodecJson(Command))
    );

    const start = decodeCommand(
      '{"_tag":"StartSession","sessionId":"s","workspaceId":"w","harness":"codex",' +
        '"placement":{"_tag":"InPlace"},"permissionMode":"auto","model":null,"prompt":"hi",' +
        '"attachments":[]}'
    );

    const fork = decodeCommand(
      '{"_tag":"ForkSession","sessionId":"f","fromSessionId":"s","fromTurnId":"t","harness":"claude"}'
    );

    expect(start).toMatchObject({ effort: null });
    expect(Predicate.isTagged(start, "StartSession") && start.origin == null).toBe(true);
    expect(fork).toMatchObject({ model: null, effort: null });
  });

  test("every catalogue entry is a capability", () => {
    const decode = Schema.decodeUnknownSync(CapabilityList);

    expect(decode(HARNESS_CATALOGUE.map((harness) => harness.capability))).toEqual([
      "harness.claude",
      "harness.codex",
      "harness.opencode",
      "harness.gemini",
      "harness.copilot",
    ]);
  });

  test("a report from before signInKind and the tested version decodes with both null", () => {
    const legacy = Schema.decodeUnknownSync(HarnessAvailability)({
      harness: "claude",
      status: "ready",
      version: "2.1.283",
      minVersion: "2.1.283",
      detail: null,
      signInArgv: ["/usr/local/bin/claude", "auth", "login"],
    });

    expect(legacy).toMatchObject({ signInKind: null, olderThanTested: null });
  });

  test("Harness availability round-trips; a status from a newer Daemon decodes as unknown", () => {
    const report = new HostHarnesses({
      checkedAt: "2026-01-01T00:00:00Z",
      harnesses: HARNESS_CATALOGUE.map(
        (harness) =>
          new HarnessAvailability({
            harness: harness.kind,
            status: "needs-sign-in",
            version: "9.9.9",
            minVersion: harness.minVersion,
            olderThanTested: harness.testedVersion,
            signInKind: null,
            detail: "Not logged in",
            signInArgv: [`/usr/local/bin/${harness.kind}`, ...harness.setup.signInCommand.slice(1)],
          })
      ),
    });

    const codec = Schema.toCodecJson(HostHarnesses);
    const json = JSON.stringify(Schema.encodeSync(codec)(report));

    expect(Schema.decodeUnknownSync(Schema.fromJsonString(codec))(json)).toEqual(report);

    const [first] = Schema.encodeSync(HostHarnesses)(report).harnesses;
    expect(first?.status).toBe("needs-sign-in");
    expect(
      Schema.decodeUnknownSync(HarnessAvailability)({ ...first, status: "rate-limited" })
    ).toMatchObject({
      status: "unknown",
    });
  });

  test("every catalogue entry declares a tested version at or above its minimum", () => {
    for (const harness of HARNESS_CATALOGUE) {
      expect(Bun.semver.satisfies(harness.minVersion, "*")).toBe(true);
      expect(Bun.semver.order(harness.minVersion, harness.testedVersion)).toBeLessThanOrEqual(0);
    }
  });

  test("items and Turn details from before Subagents decode as the Turn's own", () => {
    const completed = decodeEventJson(
      '{"_tag":"TurnItemCompleted","sessionId":"s","turnId":"t",' +
        '"item":{"_tag":"AssistantMessage","id":"m","text":"hi"}}'
    );

    expect(completed).toMatchObject({ subagentId: null });

    const detail = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.toCodecJson(TurnDetail)))(
      `{"turn":${legacyTurn},"items":[]}`
    );

    expect(detail.subagents).toEqual([]);
  });

  test("a Usage bucket from before cacheWrite1h and longContext still decodes", () => {
    const decode = Schema.decodeUnknownSync(Schema.toCodecJson(UsageBucket));

    const bucket = decode({
      hour: "2026-01-01T00:00:00Z",
      harness: "claude",
      model: "claude-opus-5-5",
      sessionId: null,
      tokens: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, reasoning: 0 },
      reportedCost: null,
    });

    expect(bucket.tokens.cacheWrite1h).toBe(0);
    expect(bucket.longContext).toEqual([]);
  });

  test("Usage from a Daemon without the indexing marker reads as caught up", () => {
    const report = Schema.decodeUnknownSync(Schema.toCodecJson(UsageReport))({
      buckets: [],
      indexedAt: null,
    });

    const codec = Schema.toCodecJson(UsageStreamItem);

    const { indexing: _dropped, ...older } = Schema.encodeSync(UsageStreamItem.cases.UsageChanged)(
      UsageStreamItem.cases.UsageChanged.make({
        buckets: [],
        indexedAt: "2026-01-01T00:00:00Z",
        indexing: true,
      })
    );

    const changed = Schema.decodeUnknownSync(codec)(older);

    expect(report.indexing).toBe(false);
    expect(changed).toMatchObject({ indexing: false });
  });
});
