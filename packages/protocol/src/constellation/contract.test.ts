import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { DomainEvent } from "../events.ts";
import { HostId, SessionId } from "../ids.ts";
import { DaemonRpcDefinitions, DaemonRpcs } from "../rpc.ts";
import { ConstellationCommand } from "./commands.ts";
import {
  AttemptState,
  TaskState,
  AttemptId,
  CheckReceipt,
  Claim,
  ConstellationId,
  ConstellationSettings,
  HostResource,
  TaskDefinition,
} from "./domain.ts";
import { ConstellationEvent, ConstellationOutboxEntry, ResourceEvent } from "./events.ts";
import { ConstellationPlan, ConstellationRpcs, ConstellationWorkerProgress } from "./rpc.ts";

const claim = Schema.decodeUnknownSync(Claim)({
  branch: "polaris/c/A1",
  head: "abc123",
  commits: ["abc123"],
  receipts: [],
  notDone: [],
  followups: [],
  questions: [],
  outsideArea: [],
  decisions: [],
  summary: "Implemented A1",
});

describe("Constellation contract", () => {
  test("retired states are rejected at protocol and event boundaries", () => {
    expect(() => Schema.decodeUnknownSync(TaskState)("future")).toThrow();
    expect(() => Schema.decodeUnknownSync(TaskState)("settled_unverified")).toThrow();
    expect(() => Schema.decodeUnknownSync(AttemptState)("settled_unverified")).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ConstellationEvent.cases.AttemptSettled)({
        constellationId: "c",
        revision: 1,
        attemptId: "a",
        attemptRevision: 1,
        outcome: "settled_unverified",
        reason: "No Claim",
      })
    ).toThrow();
  });

  test("the subgroup is mounted under DaemonRpcs with no role supplied by the caller", () => {
    for (const [tag, rpc] of ConstellationRpcs.requests) {
      expect(DaemonRpcDefinitions.requests.get(tag)).toBe(rpc);
      expect(DaemonRpcs.requests.get(tag)?.key).toBe(rpc.key);
    }

    const plan = Schema.decodeUnknownSync(ConstellationPlan.payloadSchema)({
      commandId: "cmd",
      constellationId: "c",
      operations: [],
    });

    expect(plan).toMatchObject({ resources: [] });
    expect(Object.keys(plan)).not.toContain("role");
    expect(Object.keys(plan)).not.toContain("_tag");
  });

  test("a progress report may leave out its counts", () => {
    expect(
      Schema.decodeUnknownSync(ConstellationWorkerProgress.payloadSchema)({
        commandId: "cmd",
        constellationId: "c",
        attemptId: "a",
        note: "Checking",
      })
    ).toMatchObject({ completed: null, total: null });
  });

  test("verified evidence points to a recorded item, while reported evidence is text", () => {
    expect(() =>
      Schema.decodeUnknownSync(CheckReceipt.cases.Verified)({ label: "tests", text: "passed" })
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(Schema.fromJsonString(CheckReceipt))(
        '{"_tag":"Reported","label":"tests","text":"passed"}'
      )
    ).toMatchObject({ exitCode: null });
  });

  test("every Constellation and resource tag belongs to the persisted DomainEvent codec", () => {
    for (const tag of [
      ...Object.keys(ConstellationEvent.cases),
      ...Object.keys(ResourceEvent.cases),
    ]) {
      expect(Object.keys(DomainEvent.cases)).toContain(tag);
    }
  });

  test("old Tasks and settings decode without Constellation fields", () => {
    expect(
      Schema.decodeUnknownSync(TaskDefinition)({
        id: "A1",
        title: "Protocol",
        kind: "task",
        brief: "Build",
      })
    ).toMatchObject({ deps: [], area: [], criteria: [], suggested: null });
    expect(Schema.decodeUnknownSync(ConstellationSettings)({})).toMatchObject({ defaults: null });
  });

  test("remote outboxes carry only worker commands", () => {
    const entry = new ConstellationOutboxEntry({
      id: "outbox:1",
      constellationId: ConstellationId.make("c"),
      ownerHostId: HostId.make("lead-host"),
      workerHostId: HostId.make("worker-host"),
      sessionId: SessionId.make("worker"),
      attemptId: AttemptId.make("a"),
      command: ConstellationCommand.cases.WorkerClaim.make({
        constellationId: ConstellationId.make("c"),
        attemptId: AttemptId.make("a"),
        claim,
      }),
    });

    expect(() =>
      Schema.decodeUnknownSync(ConstellationOutboxEntry)({
        ...Schema.encodeSync(ConstellationOutboxEntry)(entry),
        command: ConstellationCommand.cases.Plan.make({
          constellationId: ConstellationId.make("c"),
          operations: [],
        }),
      })
    ).toThrow();
  });

  test("a resource needs capacity", () => {
    expect(() =>
      HostResource.make({ hostId: HostId.make("h"), name: "bench", capacity: 0 })
    ).toThrow();
  });
});
