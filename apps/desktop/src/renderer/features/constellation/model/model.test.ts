import { describe, expect, test } from "bun:test";
import { Struct } from "effect";
import {
  AttemptId,
  Constellation,
  ConstellationStreamItem,
  constellationSummaryOf,
  TaskProjection,
  DomainEvent,
  EventEnvelope,
  HostStreamItem,
  Sequence,
  NotificationItem,
  ConstellationNotification,
  SessionId,
  TaskId,
  TurnId,
  WorkerLiveness,
} from "@polaris/protocol";
import {
  attempt,
  c1Record,
  constellationOf,
  handedUpAttempts,
  LEAD,
  task,
} from "../preview/graph.ts";
import { largeRecord } from "../preview/large.ts";
import { areaOverlaps, globsOverlap, type Overlap } from "./areas.ts";
import { attentionItems, nextNeedingYou } from "./attention.ts";
import { claimGlance, headMatches } from "./claim.ts";
import { idRanges, span } from "./copy.ts";
import { plainFacts } from "./facts.ts";
import { applyEnvelopes, applyHostItems, applyStreamItems, merged, startedRecord } from "./fold.ts";
import { railKey } from "./keys.ts";
import { deriveProjections } from "./project.ts";
import { buildRail, DEFAULT_RAIL, type RailRow } from "./rail.ts";
import type { TaskRow } from "./task.ts";
import { emptyConstellations } from "./types.ts";

const E = DomainEvent.cases;

/** Branded ids compare as plain strings. */
const plain = (o: Overlap | null | undefined) =>
  o == null ? null : { with: String(o.with), glob: o.glob };

const tasksOf = (rows: ReadonlyArray<RailRow>) =>
  rows.filter((r): r is TaskRow => r.kind === "task");

const rowFor = (rows: ReadonlyArray<RailRow>, id: string) =>
  tasksOf(rows).find((r) => r.task.id === id);

describe("copy", () => {
  test("folds consecutive ids into ranges", () => {
    expect(idRanges(["B1", "B2", "B3", "B4", "B5"])).toBe("B1–B5");
    expect(idRanges(["C1", "C7", "C9", "C10", "C11", "C12"])).toBe("C1, C7, C9–C12");
    expect(idRanges(["A1", "A2"])).toBe("A1, A2");
  });

  test("spans read as minutes and hours", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");

    expect(span("2026-10-01T11:56:00Z", now)).toBe("4m");
    expect(span("2026-10-01T10:00:00Z", now)).toBe("2h");
    expect(span("2026-10-01T09:55:00Z", now)).toBe("2h 5m");
    expect(span("2026-10-01T11:59:40Z", now)).toBe("now");
  });
});

describe("projections", () => {
  test("mapped unstarted and rejected Tasks use dependency readiness", () => {
    const tasks = [
      task({ id: "A", title: "source" }),
      task({ id: "B", title: "consumer", deps: ["A"] }),
    ];

    const c = constellationOf({ tasks, attempts: [] });

    expect(deriveProjections(c).map((p) => p.state)).toEqual(["ready", "waiting"]);

    const rejected = constellationOf({
      tasks,
      attempts: [attempt({ taskId: "B", state: "rejected", minutes: 1 })],
    });

    expect(deriveProjections(rejected).map((p) => p.state)).toEqual(["ready", "waiting"]);

    const accepted = constellationOf({
      tasks,
      attempts: [attempt({ taskId: "A", state: "accepted", minutes: 1 })],
    });

    expect(deriveProjections(accepted).map((p) => p.state)).toEqual(["done", "ready"]);

    const row = rowFor(buildRail(startedRecord(c, 1), plainFacts()).rows, "B");

    expect(row?.look).toMatchObject({ glyph: "waiting", word: "waiting" });
  });

  test("pending proposals are intent outside the Task projections and counts", () => {
    const record = c1Record();

    const proposed = record.proposals[0]!;

    expect(record.constellation.tasks.some((t) => t.id === proposed.task.id)).toBe(false);

    expect(record.projections.some((p) => p.taskId === proposed.task.id)).toBe(false);

    const rail = buildRail(record, plainFacts());

    expect(rail.counts.all).toBe(record.constellation.tasks.length);

    expect(rail.rows.some((r) => r.kind === "proposal")).toBe(true);

    const event = E.ProposalAccepted.make({
      constellationId: record.constellation.id,
      revision: 38,
      proposalId: proposed.proposalId,
      task: { ...Struct.omit(proposed.task, []), revision: 1, canceled: false },
    });

    const mapped = applyEnvelopes(
      { listed: new Map(), byId: new Map([[record.constellation.id, record]]) },
      [{ sequence: 121, occurredAt: "2026-10-01T12:00:00Z", event }]
    ).byId.get(record.constellation.id)!;

    expect(mapped.proposals.some((p) => p.proposalId === proposed.proposalId)).toBe(false);

    expect(mapped.projections.find((p) => p.taskId === proposed.task.id)?.state).toBe("ready");
  });

  test("a Task follows its latest Attempt and waits on unfinished deps", () => {
    const c = constellationOf();
    const p = new Map(deriveProjections(c).map((x) => [x.taskId, x]));

    expect(p.get(TaskId.make("A1"))?.state).toBe("done");
    expect(p.get(TaskId.make("B1"))?.state).toBe("review");
    expect(p.get(TaskId.make("B2"))?.state).toBe("working");
    expect(p.get(TaskId.make("G2"))?.state).toBe("waiting");
    expect(p.get(TaskId.make("G2"))?.blockedBy.map(String)).toEqual(["B1", "B2", "B3", "B4", "B5"]);
    expect(p.get(TaskId.make("G1"))?.gatePromoted).toBe(true);
  });

  test("keeps the Daemon's stale and fetched flags", () => {
    const c = constellationOf();

    const known = deriveProjections(c).map((x) =>
      x.taskId === "B4" ? { ...x, branchFetched: false, stale: true } : x
    );

    const b4 = deriveProjections(c, known).find((x) => x.taskId === "B4");

    expect(b4?.branchFetched).toBe(false);
    expect(b4?.stale).toBe(true);
  });

  test("keeps observed liveness only while the Task's latest Attempt is unchanged", () => {
    const c = constellationOf();

    const live = new WorkerLiveness({
      current: null,
      lastOutputAt: 1000,
      contextPercent: 50,
      queuedInput: 1,
    });

    const known = deriveProjections(c).map((p) =>
      p.taskId === "B2" ? { ...p, liveness: live } : p
    );

    expect(deriveProjections(c, known).find((p) => p.taskId === "B2")?.liveness).toEqual(live);

    const replaced = constellationOf({
      attempts: [...c.attempts, attempt({ taskId: "B2", state: "working", minutes: 1, n: 2 })],
    });

    expect(deriveProjections(replaced, known).find((p) => p.taskId === "B2")?.liveness).toBeNull();
    expect(deriveProjections(c).every((p) => p.liveness === null)).toBe(true);
  });
});

describe("fold", () => {
  const graph = { constellationId: constellationOf().id };

  const loaded = (c = constellationOf()) => ({
    listed: new Map([[c.id, constellationSummaryOf(c)]]),
    byId: new Map([[c.id, startedRecord(c, 1)]]),
  });

  const envelope = (sequence: number, event: DomainEvent, at = "2026-10-01T12:00:00Z") => ({
    sequence,
    occurredAt: at,
    event,
  });

  test("the Host feed only lists graphs: Snapshot summaries and listing events", () => {
    const c = constellationOf();

    const listed = applyHostItems(emptyConstellations, [
      HostStreamItem.cases.Snapshot.make({
        sequence: Sequence.make(1),
        workspaces: [],
        worktrees: [],
        sessions: [],
        constellations: [constellationSummaryOf(c)],
      }),
      HostStreamItem.cases.Event.make({
        envelope: new EventEnvelope({
          sequence: Sequence.make(2),
          occurredAt: "2026-10-01T12:00:00Z",
          commandId: null,
          event: E.ConstellationStateChanged.make({ ...graph, revision: 38, state: "paused" }),
        }),
      }),
    ]);

    expect(listed.listed.get(c.id)?.state).toBe("paused");
    expect(listed.byId.size).toBe(0);
  });

  test("a removed Workspace takes its graphs off the Host feed's listing", () => {
    const c = constellationOf();

    const listed = applyHostItems(emptyConstellations, [
      HostStreamItem.cases.Snapshot.make({
        sequence: Sequence.make(1),
        workspaces: [],
        worktrees: [],
        sessions: [],
        constellations: [constellationSummaryOf(c)],
      }),
      HostStreamItem.cases.Event.make({
        envelope: new EventEnvelope({
          sequence: Sequence.make(2),
          occurredAt: "2026-10-01T12:00:00Z",
          commandId: null,
          event: E.WorkspaceRemoved.make({ workspaceId: c.workspaceId }),
        }),
      }),
    ]);

    expect(listed.listed.size).toBe(0);
  });

  test("a stream Snapshot is the record: graph, projections and the owner's journal", () => {
    const record = c1Record();

    const model = applyStreamItems(emptyConstellations, [
      ConstellationStreamItem.cases.Snapshot.make({
        sequence: Sequence.make(7),
        constellation: new Constellation(record.constellation),
        projections: record.projections.map((p) => new TaskProjection(p)),
        proposals: [],
        progress: [],
        messages: [],
        digests: [],
        handovers: [],
      }),
    ]);

    const r = model.byId.get(record.constellation.id);

    expect(r?.sequence).toBe(7);
    expect(r?.projections.find((p) => p.taskId === "B4")?.branchFetched).toBe(false);
  });

  test("a Claim moves the Attempt to review and stamps it; acceptance makes the Task done", () => {
    const id = AttemptId.make("att-B2-1");
    const claim = c1Record().constellation.attempts.find((a) => a.taskId === "B1")?.claim;

    const claimed = applyEnvelopes(loaded(), [
      envelope(
        2,
        E.AttemptClaimed.make({
          ...graph,
          revision: 38,
          attemptId: id,
          attemptRevision: 3,
          claim: claim!,
        })
      ),
    ]);

    const r1 = claimed.byId.get(graph.constellationId);

    expect(r1?.projections.find((p) => p.taskId === "B2")?.state).toBe("review");
    expect(r1?.constellation.attempts.find((a) => a.id === id)?.claimedAt).toBe(
      "2026-10-01T12:00:00Z"
    );
    expect(r1?.sequence).toBe(2);

    const accepted = applyEnvelopes(claimed, [
      envelope(
        3,
        E.AttemptAccepted.make({
          ...graph,
          revision: 39,
          attemptId: id,
          attemptRevision: 4,
          mergedHead: "3f9c2e1",
          receipts: [],
          evidence: "asserted",
        })
      ),
    ]);

    expect(
      accepted.byId.get(graph.constellationId)?.projections.find((p) => p.taskId === "B2")?.state
    ).toBe("done");
  });

  test("a digest names its notifications and clears them from pending", () => {
    const n = new ConstellationNotification({
      id: "n-1",
      item: NotificationItem.cases.Settled.make({
        attemptId: AttemptId.make("att-B1-1"),
        state: "review",
      }),
      queuedAt: "2026-10-01T12:00:00Z",
    });

    const model = applyEnvelopes(loaded(constellationOf({ pendingNotifications: [] })), [
      envelope(2, E.NotificationQueued.make({ ...graph, revision: 38, notification: n })),
      envelope(
        3,
        E.LeadNotified.make({
          ...graph,
          revision: 39,
          leadSessionId: LEAD,
          items: ["n-1"],
          turnId: TurnId.make("t-9"),
        })
      ),
    ]);

    const r = model.byId.get(graph.constellationId);

    expect(r?.digests.at(-1)?.items.map((i) => i.id)).toEqual(["n-1"]);
    expect(r?.constellation.pendingNotifications).toEqual([]);
  });

  test("a handover records the old Lead and the graph as it stood", () => {
    const to = SessionId.make("s-lead-2");

    const model = applyEnvelopes(loaded(), [
      envelope(
        2,
        E.LeadChanged.make({ ...graph, revision: 38, from: LEAD, to, summary: "Carry on." })
      ),
    ]);

    const r = model.byId.get(graph.constellationId);

    expect(r?.constellation.leadSessionId).toBe(to);
    expect(r?.handovers[0]?.inFlight.map(String)).toEqual([
      "att-B1-1",
      "att-B2-1",
      "att-B3-1",
      "att-B4-1",
      "att-B5-1",
    ]);
  });

  test("handover includes a blocked Attempt and unblock clears its nudge metadata", () => {
    const a = attempt({ taskId: "B2", state: "blocked", minutes: 1 });

    const c = constellationOf({
      attempts: [
        {
          ...Struct.omit(a, []),
          nudgedAt: "2026-10-01T11:00:00Z",
          blockedOn: [TaskId.make("B3")],
          blockedReason: "feed",
          blockedAt: "2026-10-01T11:30:00Z",
        },
      ],
    });

    const model = applyEnvelopes(loaded(c), [
      envelope(
        2,
        E.LeadChanged.make({
          ...graph,
          revision: 38,
          from: LEAD,
          to: SessionId.make("new-lead"),
          summary: "Carry on",
        })
      ),
      envelope(
        3,
        E.TaskCanceled.make({ ...graph, revision: 39, taskId: TaskId.make("B3"), taskRevision: 1 })
      ),
    ]);

    expect(model.byId.get(c.id)?.handovers[0]?.inFlight).toContain(a.id);
    expect(model.byId.get(c.id)?.constellation.attempts[0]?.blockedOn).toEqual([]);

    const resumed = applyEnvelopes(model, [
      envelope(
        4,
        E.AttemptUnblocked.make({
          ...graph,
          revision: 40,
          attemptId: a.id,
          attemptRevision: 2,
          cause: "Lead",
          at: "2026-10-01T12:00:00Z",
        })
      ),
    ]);

    expect(resumed.byId.get(c.id)?.constellation.attempts[0]).toMatchObject({
      state: "working",
      nudgedAt: null,
      blockedOn: [],
      blockedReason: null,
      blockedAt: null,
    });
  });

  test("BranchFetched updates only the latest Attempt and preserves the graph revision", () => {
    const start = loaded();

    const fetched = applyStreamItems(start, [
      ConstellationStreamItem.cases.BranchFetched.make({
        attemptId: AttemptId.make("att-B4-1"),
        branchFetched: true,
      }),
    ]);

    expect(
      fetched.byId.get(graph.constellationId)?.projections.find((p) => p.taskId === "B4")
        ?.branchFetched
    ).toBe(true);
    expect(fetched.byId.get(graph.constellationId)?.constellation.revision).toBe(
      start.byId.get(graph.constellationId)?.constellation.revision
    );
    expect(
      applyStreamItems(start, [
        ConstellationStreamItem.cases.BranchFetched.make({
          attemptId: AttemptId.make("att-B4-0"),
          branchFetched: true,
        }),
      ])
    ).toBe(start);
  });

  test("LivenessChanged lands on the latest Attempt's projection only", () => {
    const start = loaded();

    const liveness = new WorkerLiveness({
      current: null,
      lastOutputAt: 1_700_000_000_000,
      contextPercent: 61,
      queuedInput: 2,
    });

    const live = applyStreamItems(start, [
      ConstellationStreamItem.cases.LivenessChanged.make({
        attemptId: AttemptId.make("att-B2-1"),
        liveness,
      }),
    ]);

    const b2 = live.byId.get(graph.constellationId)?.projections.find((p) => p.taskId === "B2");

    expect(b2?.liveness?.queuedInput).toBe(2);

    const stale = applyStreamItems(start, [
      ConstellationStreamItem.cases.LivenessChanged.make({
        attemptId: AttemptId.make("att-B2-0"),
        liveness,
      }),
    ]);

    expect(stale).toBe(start);
  });

  test("events for a graph the stream hasn't loaded are ignored", () => {
    const model = applyEnvelopes(emptyConstellations, [
      envelope(1, E.ConstellationStateChanged.make({ ...graph, revision: 2, state: "paused" })),
    ]);

    expect(model.byId.size).toBe(0);
  });
});

describe("rail", () => {
  const facts = plainFacts({
    receipt: (ref) =>
      ref.itemId === "i-trace" ? { command: "trace", exitCode: 1 } : { command: "x", exitCode: 0 },
  });

  test("C1: groups, a handover row, the proposal and the unstarted Task", () => {
    const rail = buildRail(c1Record(), facts);
    const kinds = rail.rows.map((r) => r.kind);

    expect(kinds[0]).toBe("handover");
    expect(
      rail.rows.filter((r) => r.kind === "group").map((r) => (r.kind === "group" ? r.label : ""))
    ).toEqual(["A · Events and decider", "B · Spec and tools"]);
    expect(kinds).toContain("proposal");
    expect(rail.large).toBe(false);
  });

  test("a Claim row shows the Claim at a glance", () => {
    const b1 = rowFor(buildRail(c1Record(), facts).rows, "B1");

    expect(b1?.look.word).toBe("in review");
    expect(b1?.line?.kind).toBe("claim");

    if (b1?.line?.kind === "claim") {
      expect(b1.line.glance.checks.map((c) => c.ok)).toEqual([true, true, false]);
      expect(b1.line.glance.notDone).toBe(1);
      expect(b1.line.glance.questions).toBe(1);
    }
  });

  test("a gate waits on its inputs and lists receipts once accepted", () => {
    const rows = buildRail(c1Record(), facts).rows;

    expect(rowFor(rows, "G2")?.look.word).toBe("after B1–B5");
    expect(rowFor(rows, "G2")?.look.glyph).toBe("gate");
    expect(rowFor(rows, "G1")?.look.glyph).toBe("gate-accepted");
    expect(rowFor(rows, "G1")?.line?.kind).toBe("accepted");
  });

  test("a Gate's working inputs take their worker's Harness hue", () => {
    const hued = plainFacts({
      worker: (a) => ({
        ...plainFacts().worker(a),
        harness: a.taskId === "B3" ? "claude" : "codex",
      }),
    });

    const inputs = rowFor(buildRail(c1Record(), hued).rows, "G2")?.inputs ?? [];

    expect(inputs.map((i) => [i.taskId, i.glyph, i.harness])).toEqual([
      ["B1", "review", "codex"],
      ["B2", "working", "codex"],
      ["B3", "working", "claude"],
      ["B4", "review-unfetched", "codex"],
      ["B5", "working", "codex"],
    ]);
  });

  test("an unfetched branch says so; an overlap warns once per pair", () => {
    const rows = buildRail(c1Record(), facts).rows;

    expect(rowFor(rows, "B4")?.look.glyph).toBe("review-unfetched");
    expect(rowFor(rows, "B4")?.line).toMatchObject({ text: "review · branch not yet fetched" });
    expect(plain(rowFor(rows, "B3")?.overlap)).toEqual({
      with: "B2",
      glob: "apps/daemon/src/mcp/**",
    });
    expect(rowFor(rows, "B2")?.overlap).toBeNull();
  });

  test("a stopped worker needs you; a handed-up Claim says so and is promoted", () => {
    const record = c1Record({ attempts: handedUpAttempts() });

    const withSignals = plainFacts({
      worker: (a) => ({ ...facts.worker(a), stoppedWithoutClaiming: a.taskId === "B5" }),
    });

    const rows = buildRail(record, withSignals).rows;

    expect(rowFor(rows, "B5")?.look).toMatchObject({ word: "needs you", glyph: "needs-you" });
    expect(rowFor(rows, "B5")?.line).toMatchObject({
      text: "stopped without reporting back",
      detail: "reminded once",
    });
    expect(rowFor(rows, "B1")?.look.word).toBe("handed to you");
    expect(rowFor(rows, "B1")?.promoted).toBe(true);
  });

  test("ENG-742: a worker waiting on background work is neutral and working, never stopped", () => {
    const now = Date.parse("2026-10-01T12:10:00Z");

    const waiting = (until: number) =>
      plainFacts({
        now,
        worker: (a) => ({
          ...facts.worker(a),
          activeTurn: a.taskId === "B5" ? false : facts.worker(a).activeTurn,
          firstTurn: true,
          // The session went idle after the nudge: without the wait, this reads stopped.
          stoppedWithoutClaiming: a.taskId === "B5",
          waiting:
            a.taskId === "B5"
              ? {
                  tasks: [{ kind: "command", description: "bench.sh" }],
                  on: null,
                  since: "2026-10-01T12:06:00Z",
                  until,
                }
              : null,
        }),
      });

    const b5 = rowFor(buildRail(c1Record(), waiting(now + 60_000)).rows, "B5");

    expect(b5?.look).toMatchObject({
      word: "waiting on a command · 4m",
      glyph: "waiting",
      wordTone: "neutral",
      attention: null,
      bucket: "working",
    });
    expect(b5?.line).toMatchObject({ text: "bench.sh", detail: "wakes when it ends" });

    // Once the wait runs out, the silent end is the worker's again.
    const expired = rowFor(buildRail(c1Record(), waiting(now)).rows, "B5");

    expect(expired?.look).toMatchObject({ word: "needs you", glyph: "needs-you" });
  });

  test("approving a handed-up Claim settles the user's part: no longer handed or promoted", () => {
    const attempts = handedUpAttempts().map((a) =>
      a.taskId === "B1" ? merged(a, { approvedByUserAt: "2026-10-01T12:00:00Z" }) : a
    );

    const b1 = rowFor(buildRail(c1Record({ attempts }), facts).rows, "B1");

    expect(b1?.look.attention).toBeNull();
    expect(b1?.look.word).not.toBe("handed to you");
    expect(b1?.promoted).toBe(false);
  });

  test("an approved Claim says so and stays in review", () => {
    const attempts = c1Record().constellation.attempts.map((a) =>
      a.taskId === "B1" ? merged(a, { approvedByUserAt: "2026-10-01T12:00:00Z" }) : a
    );

    const b1 = rowFor(buildRail(c1Record({ attempts }), facts).rows, "B1");

    expect(b1?.look.word).toBe("in review");
    expect(b1?.line).toMatchObject({ kind: "claim", glance: { approved: true } });
  });

  test("a paused Constellation promotes Accept / Send back on every Claim", () => {
    const rows = buildRail(c1Record({ state: "paused" }), facts).rows;

    expect(rowFor(rows, "B1")?.promoted).toBe(true);
    expect(rowFor(rows, "B2")?.promoted).toBe(false);
  });

  test("C8: 128 Tasks fold, groups that need you or hold a block open, waiting folds", () => {
    const record = largeRecord();

    const rail = buildRail(record, plainFacts());
    const open = rail.rows.filter((r) => r.kind === "group" && r.open);

    expect(rail.large).toBe(true);
    expect(open.map((r) => (r.kind === "group" ? r.group : ""))).toEqual([
      "C · Tool surface",
      "I · Updater",
    ]);
    expect(rail.rows.find((r) => r.kind === "waiting")).toMatchObject({ ids: "C7–C12", count: 6 });
    expect(rail.counts).toMatchObject({ all: 132, "needs-you": 1, review: 6, done: 72 });
    expect(tasksOf(rail.rows).every((r) => r.line === null)).toBe(true);
  });

  test("a working Attempt's Subagents are nodes under its row", () => {
    const withSubagent = plainFacts({
      worker: (a) => ({
        ...plainFacts().worker(a),
        subagents:
          a.taskId === "B2"
            ? [
                {
                  id: "sa-1",
                  title: "Read the docs",
                  agent: "Explore",
                  since: "2026-10-01T12:00:00Z",
                },
              ]
            : [],
      }),
    });

    const rows = buildRail(c1Record(), withSubagent).rows;
    const at = rows.findIndex((r) => r.key === "task:B2");

    expect(rows[at + 1]).toMatchObject({ kind: "subagent", key: "subagent:sa-1" });
    expect(railKey("Enter", rows, "subagent:sa-1")).toMatchObject({ kind: "focus" });
    expect(buildRail(largeRecord(), withSubagent).rows.some((r) => r.kind === "subagent")).toBe(
      false
    );
  });

  test("a silent worker reads quiet; a running command doesn't", () => {
    const now = Date.parse("2026-10-01T12:10:00Z");

    const quiet = plainFacts({
      now,
      worker: (a) => ({
        ...plainFacts().worker(a),
        quietSince: a.taskId === "B2" ? "2026-10-01T12:06:00Z" : null,
        queued: a.taskId === "B2" ? 2 : 0,
      }),
    });

    const b2 = rowFor(buildRail(c1Record(), quiet).rows, "B2");

    expect(b2?.line).toMatchObject({ kind: "liveness", quiet: "quiet 4m", queued: 2 });
  });

  test("a worker queued for a slot reads waiting, not working", () => {
    const now = Date.parse("2026-10-01T12:10:00Z");

    const queued = plainFacts({
      now,
      worker: (a) => ({
        ...plainFacts().worker(a),
        activity:
          a.taskId === "B3"
            ? { kind: "slot", host: "devbox", since: "2026-10-01T12:08:00Z" }
            : null,
      }),
    });

    const b3 = rowFor(buildRail(c1Record(), queued).rows, "B3");

    expect(b3?.look).toMatchObject({ glyph: "waiting", word: "waiting · 2m", bucket: "working" });
    expect(b3?.line).toMatchObject({ activity: "waiting for a slot on devbox", mono: false });
  });

  test("filters and queries flatten to matching Tasks", () => {
    const rail = buildRail(largeRecord(), plainFacts(), { ...DEFAULT_RAIL, filter: "review" });

    expect(tasksOf(rail.rows).every((r) => r.look.bucket === "review")).toBe(true);
    expect(tasksOf(rail.rows)).toHaveLength(6);

    const query = buildRail(c1Record(), facts, { ...DEFAULT_RAIL, query: "quint" });

    expect(tasksOf(query.rows).map((r) => String(r.task.id))).toEqual(["B1"]);
  });
});

describe("attention", () => {
  test("ranks approvals before questions before stopped workers", () => {
    const record = c1Record();

    const facts = plainFacts({
      worker: (a) => ({
        ...plainFacts().worker(a),
        stoppedWithoutClaiming: a.taskId === "B5",
        approvalSince: a.taskId === "B2" ? "2026-10-01T12:00:00Z" : null,
      }),
    });

    const items = attentionItems(buildRail(record, facts).tasks, facts);

    expect(items.map((i) => i.text)).toEqual([
      "B2 waiting on your approval",
      "B5 stopped without reporting back",
    ]);
    expect(nextNeedingYou(items, "B2")).toBe("B5");
    expect(nextNeedingYou(items, "B5")).toBe("B2");
  });

  test("blocked workers retain approval and offline attention, without stopped attention", () => {
    const c = constellationOf({
      attempts: [attempt({ taskId: "B2", state: "blocked", minutes: 1 })],
    });

    const record = startedRecord(c, 1);

    const approval = plainFacts({
      worker: (a) => ({
        ...plainFacts().worker(a),
        approvalSince: "2026-10-01T12:00:00Z",
        stoppedWithoutClaiming: true,
      }),
    });

    expect(attentionItems(buildRail(record, approval).tasks, approval).map((i) => i.text)).toEqual([
      "B2 waiting on your approval",
    ]);

    const offline = plainFacts({
      worker: (a) => ({
        ...plainFacts().worker(a),
        hostAway: "offline",
        stoppedWithoutClaiming: true,
      }),
    });

    expect(attentionItems(buildRail(record, offline).tasks, offline).map((i) => i.text)).toEqual([
      "B2's host is offline",
    ]);
  });

  test("the Lead near its context limit is offered a handover", () => {
    const facts = plainFacts({ lead: { harness: "claude", model: "opus", contextPercent: 88 } });

    expect(attentionItems([], facts).map((i) => i.text)).toEqual([
      "Lead at 88% context · hand over",
    ]);
  });
});

describe("keys", () => {
  const rows = buildRail(c1Record(), plainFacts()).rows;

  test("arrows move, enter focuses, tab looks for the next that needs you", () => {
    expect(railKey("ArrowDown", rows, null)).toEqual({ kind: "select", key: rows[0]!.key });
    expect(railKey("Enter", rows, "task:B1")).toMatchObject({ kind: "focus" });
    expect(railKey("Tab", rows, null)).toEqual({ kind: "next-needs-you" });
  });

  test("a and s act only on a Claim in review", () => {
    expect(railKey("a", rows, "task:B1")).toMatchObject({ kind: "review", mode: "accept" });
    expect(railKey("s", rows, "task:B2")).toBeNull();
  });

  test("← from a nested Task selects its group, then folds it", () => {
    expect(railKey("ArrowLeft", rows, "task:B2")).toEqual({
      kind: "select",
      key: "group:B · Spec and tools",
    });
    expect(railKey("ArrowLeft", rows, "group:B · Spec and tools")).toMatchObject({
      kind: "toggle",
      open: false,
    });
  });
});

describe("claims and areas", () => {
  test("the merged head must match the claimed head", () => {
    expect(headMatches("3f9c2e1a77", "3f9c2e1")).toBe(true);
    expect(headMatches("3f9c2e1a77", "3f9c2e")).toBe(false);
    expect(headMatches("3f9c2e1a77", "aaaaaaa")).toBe(false);
  });

  test("a Claim with no receipts is asserted", () => {
    const claim = c1Record().constellation.attempts.find((a) => a.taskId === "B1")!.claim!;

    expect(claimGlance(merged(claim, { receipts: [] }), plainFacts()).asserted).toBe(true);
  });

  test("globs overlap by their literal prefix", () => {
    expect(globsOverlap("apps/daemon/src/mcp/**", "apps/daemon/**")).toBe(true);
    expect(globsOverlap("packages/spec/**", "apps/**")).toBe(false);

    const tasks = [
      task({ id: "X1", title: "x", area: ["a/**"] }),
      task({ id: "X2", title: "y", area: ["a/b/**"] }),
    ];

    const projections = new Map(
      deriveProjections(
        constellationOf({
          tasks,
          attempts: [
            attempt({ taskId: "X1", state: "working", minutes: 1 }),
            attempt({ taskId: "X2", state: "working", minutes: 1 }),
          ],
        })
      ).map((p) => [p.taskId, p])
    );

    expect(plain(areaOverlaps(tasks, projections).get(TaskId.make("X2")))).toEqual({
      with: "X1",
      glob: "a/b/**",
    });
  });
});
