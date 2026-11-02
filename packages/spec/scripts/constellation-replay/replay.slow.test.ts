import { describe, expect, test } from "bun:test";
import { Schema, Struct } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  Attempt,
  AttemptCause,
  AttemptId,
  Claim,
  Constellation,
  ConstellationId,
  ConstellationNotification,
  ConstellationSettings,
  HostResource,
  NotificationItem,
  ResourceLease,
  Task,
  TaskId,
} from "../../../protocol/src/constellation/domain.ts";
import { MessageTarget } from "../../../protocol/src/constellation/commands.ts";
import { DomainEvent } from "../../../protocol/src/events.ts";
import { Turn } from "../../../protocol/src/domain.ts";
import { HostId, SessionId, TurnId, WorkspaceId } from "../../../protocol/src/ids.ts";
import {
  constellationTraceToQuint,
  ConstellationTrace,
  decodeConstellationTrace,
  ResourceLeaseCanceled,
  ResourceRemoved,
} from "./index.ts";

const host = HostId.make("lead-host");

const lead = SessionId.make("lead");

const worker = SessionId.make("worker");

const constellationId = ConstellationId.make("graph");

const attemptId = AttemptId.make("attempt");

const E = DomainEvent.cases;

const time = "2026-10-01T00:00:00Z";

const graph = { constellationId, revision: 1 };

const target = { ...graph, attemptId, attemptRevision: 2 };

const claim = new Claim({
  branch: "polaris/graph/A",
  head: "head-1",
  commits: ["head-1"],
  receipts: [],
  notDone: [],
  followups: [],
  questions: [],
  outsideArea: [],
  decisions: [],
  summary: "Done",
});

const started = E.ConstellationStarted.make({
  ...graph,
  constellation: new Constellation({
    id: constellationId,
    workspaceId: WorkspaceId.make("workspace"),
    hostId: host,
    leadSessionId: lead,
    name: "Graph",
    state: "planning",
    revision: 0,
    settings: new ConstellationSettings({}),
    tasks: [],
    attempts: [],
    pendingNotifications: [],
    createdAt: time,
    updatedAt: time,
  }),
});

const task = new Task({
  id: TaskId.make("A"),
  title: "A",
  brief: "Build A",
  kind: "task",
  revision: 1,
  canceled: false,
});

const gate = new Task({
  id: TaskId.make("G"),
  title: "G",
  brief: "Verify A",
  kind: "gate",
  deps: [task.id],
  revision: 1,
  canceled: false,
});

const began = E.AttemptStarted.make({
  ...graph,
  attempt: new Attempt({
    id: attemptId,
    taskId: task.id,
    revision: 1,
    cause: AttemptCause.cases.Initial.make({}),
    by: lead,
    sessionId: worker,
    hostId: host,
    worktree: "/temp/A",
    branch: claim.branch,
    base: "base",
    state: "working",
    claimedAt: null,
    approvedByUserAt: null,
    handedUpAt: null,
    handedUpReason: null,
    nudgedAt: null,
    startedAt: time,
  }),
});

const notification = (id: string, state: "review" | "lost") =>
  E.NotificationQueued.make({
    ...graph,
    notification: new ConstellationNotification({
      id,
      queuedAt: time,
      item: NotificationItem.cases.Settled.make({ attemptId, state }),
    }),
  });

const initial = [
  started,
  E.TaskDeclared.make({ ...graph, task }),
  E.TaskDeclared.make({ ...graph, task: gate }),
  E.ConstellationStateChanged.make({ ...graph, state: "running" }),
];

const reviewed = [began, E.AttemptClaimed.make({ ...target, claim }), notification("n", "review")];

const accepted = [
  E.AttemptAccepted.make({ ...target, mergedHead: claim.head, receipts: [], evidence: "asserted" }),
  E.GatePromoted.make({ ...graph, taskId: gate.id, taskRevision: 1 }),
  E.LeadNotified.make({
    ...graph,
    leadSessionId: lead,
    items: ["n"],
    turnId: TurnId.make("digest"),
  }),
];

const batch = (events: ReadonlyArray<DomainEvent>) => ({ hostId: host, events });

const trace = (batches: ConstellationTrace["batches"]): ConstellationTrace => ({
  version: 1,
  ownerHostId: host,
  batches,
});

const spec = join(import.meta.dir, "../..");

/**
 * True when Quint's `replayTest` passes, false only when `safety` fails on a replayed batch
 * (QNT508); a parse, type or other Quint error throws with Quint's output.
 */
const verdict = (main: string, exitCode: number | null, stdout: string, stderr: string) => {
  if (exitCode === 0) return true;

  const rejected =
    exitCode === 1 &&
    stdout.includes("1) replayTest failed") &&
    stdout.includes("Error [QNT508]: Expect condition does not hold true");

  if (rejected) return false;
  throw new Error(`quint test ${main} did not replay (exit ${exitCode}):\n${stderr}\n${stdout}`);
};

// Each `quint test` is a CPU-bound Node process, so concurrent checks share a bounded pool.
let free = Math.max(2, Math.floor(navigator.hardwareConcurrency / 2));

const queue: Array<() => void> = [];

const pooled = async <A>(task: () => Promise<A>): Promise<A> => {
  if (free > 0) free--;
  else await new Promise<void>((resume) => queue.push(resume));

  try {
    return await task();
  } finally {
    const next = queue.shift();

    if (next) next();
    else free++;
  }
};

const replay = (path: string, main: string) =>
  pooled(async () => {
    const child = Bun.spawn(
      [
        join(spec, "node_modules/.bin/quint"),
        "test",
        path,
        `--main=${main}`,
        "--backend=typescript",
      ],
      { stdout: "pipe", stderr: "pipe" }
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    return verdict(main, exitCode, stdout, stderr);
  });

const check = async (input: ConstellationTrace): Promise<boolean> => {
  const root = mkdtempSync(join(tmpdir(), "polaris-replay-test-"));

  try {
    const sources = constellationTraceToQuint(
      "check",
      input,
      relative(root, join(spec, "constellations"))
    );

    const verdicts = await Promise.allSettled(
      sources.map((source) => {
        const path = join(root, `${source.name}.qnt`);
        writeFileSync(path, source.source);

        return replay(path, source.name);
      })
    );

    let conforms = true;

    for (const result of verdicts) {
      if (result.status === "rejected") throw result.reason;
      conforms &&= result.value;
    }

    return conforms;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

/** Replays the labelled traces concurrently and expects each label's verdict. */
const expectVerdicts = async (
  cases: ReadonlyArray<readonly [label: string, input: ConstellationTrace, conforms: boolean]>
) => {
  const verdicts = await Promise.all(cases.map(([, input]) => check(input)));

  expect(Object.fromEntries(cases.map(([label], index) => [label, verdicts[index]]))).toEqual(
    Object.fromEntries(cases.map(([label, , conforms]) => [label, conforms]))
  );
};

const unblockFixture = () => {
  const blocked = E.AttemptBlocked.make({
    ...target,
    on: [],
    reason: "Waiting for the Lead",
    at: time,
  });

  const unblocked = E.AttemptUnblocked.make({ ...target, cause: "Lead", at: time });

  const delivered = E.WorkerInputDelivered.make({
    ...graph,
    id: "message",
    sessionId: worker,
    at: time,
  });

  const turn = new Turn({
    id: TurnId.make(JSON.stringify([delivered.id, worker])),
    sessionId: worker,
    index: 1,
    prompt: "Continue A",
    attachments: [],
    model: null,
    effort: null,
    status: "working",
    checkpointBefore: null,
    checkpointAfter: null,
    startedAt: time,
    endedAt: null,
  });

  const message = E.OperatorMessageSent.make({
    ...graph,
    revision: blocked.revision + 1,
    id: delivered.id,
    authority: "conversation",
    target: MessageTarget.cases.Worker.make({ attemptId }),
    text: "Continue A",
    questionId: null,
  });

  return { blocked, unblocked, delivered, message, turn: E.TurnStarted.make({ turn }) };
};

test("local unblock replay requires a worker Turn in the same committed batch", () => {
  const f = unblockFixture();

  const source = (events: DomainEvent[]) =>
    constellationTraceToQuint(
      "block",
      trace([batch(initial), batch([began, f.blocked]), batch([f.message]), batch(events)]),
      "constellations"
    )[0]!.source;

  expect(source([f.unblocked, f.delivered])).toContain('cause: "Lead", turn: false');
  expect(source([f.turn, f.unblocked, f.delivered])).toContain('cause: "Lead", turn: true');
});

test("remote unblock replay requires the exact earlier worker Host Turn and owner receipt", () => {
  const f = unblockFixture();
  const remote = HostId.make("remote");

  const remoteBegan = E.AttemptStarted.make({
    ...began,
    attempt: new Attempt(Struct.assign(began.attempt, { hostId: remote })),
  });

  const source = (remoteBatch: ConstellationTrace["batches"][number], receipts: DomainEvent[]) =>
    constellationTraceToQuint(
      "remote_block",
      trace([
        batch(initial),
        batch([remoteBegan, f.blocked]),
        batch([f.message]),
        remoteBatch,
        batch([f.unblocked, ...receipts]),
      ]),
      "constellations"
    )[0]!.source;

  expect(source({ hostId: remote, events: [f.turn] }, [f.delivered])).toContain(
    'cause: "Lead", turn: true'
  );
  expect(source({ hostId: HostId.make("other-host"), events: [f.turn] }, [f.delivered])).toContain(
    'cause: "Lead", turn: false'
  );
  expect(source({ hostId: remote, events: [f.turn] }, [])).toContain('cause: "Lead", turn: false');
  expect(
    source(
      {
        hostId: remote,
        events: [
          E.TurnStarted.make({
            turn: new Turn(Struct.assign(f.turn.turn, { id: TurnId.make("another-input") })),
          }),
        ],
      },
      [f.delivered]
    )
  ).toContain('cause: "Lead", turn: false');
});

describe("Constellation real-log replay", () => {
  test.concurrent("protocol events replay Claims, acceptance, Gate promotion and digest delivery", async () => {
    expect(await check(trace([batch(initial), batch(reviewed), batch(accepted)]))).toBe(true);
  });

  test.concurrent("JSON boundary and CLI replay a representative log", async () => {
    const input = trace([batch(initial)]);

    const encoded = Schema.encodeSync(
      Schema.fromJsonString(Schema.toCodecJson(ConstellationTrace))
    )(input);

    // Claims, Gate and delivery replay above; the CLI smoke needs only one Quint subprocess.
    expect(decodeConstellationTrace(encoded)).toEqual(input);
    const dir = mkdtempSync(join(tmpdir(), "polaris-replay-cli-"));

    try {
      const file = join(dir, "trace.json");
      writeFileSync(file, encoded);

      const result = await pooled(async () => {
        const child = Bun.spawn(
          ["bun", join(import.meta.dir, "../replay-constellation.ts"), file],
          { stdout: "pipe", stderr: "pipe" }
        );

        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);

        return { stdout, stderr, exitCode };
      });

      expect(result).toMatchObject({ exitCode: 0 });
      expect(result.stdout).toContain("1/1 traces conform");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("complete graph history and unique start are required", () => {
    expect(() =>
      constellationTraceToQuint("bad", trace([batch(initial.slice(1))]), "model")
    ).toThrow("earlier ConstellationStarted");
    expect(() =>
      constellationTraceToQuint("bad", trace([batch(initial), batch([started])]), "model")
    ).toThrow("repeated");
  });

  test.concurrent("refused remote intents can commit empty owner receipt batches", async () => {
    const receipt = { hostId: host, events: [], outboxId: "refused", constellationId };

    await expectVerdicts([
      ["one empty receipt", trace([batch(initial), receipt]), true],
      ["the same receipt twice", trace([batch(initial), receipt, receipt]), false],
    ]);
  });

  test.concurrent("a mismatched merged head is rejected by the reference model", async () => {
    const wrong = E.AttemptAccepted.make({
      ...target,
      mergedHead: "wrong-head",
      receipts: [],
      evidence: "asserted",
    });

    expect(
      await check(trace([batch(initial), batch(reviewed), batch([wrong, ...accepted.slice(1)])]))
    ).toBe(false);
  });

  test.concurrent("repeated delivery and delivery to the previous Lead are rejected", async () => {
    const delivered = E.LeadNotified.make({
      ...graph,
      leadSessionId: lead,
      items: ["n"],
      turnId: TurnId.make("digest"),
    });

    const handover = E.LeadChanged.make({
      ...graph,
      from: lead,
      to: SessionId.make("next-lead"),
      summary: "Continue",
    });

    await expectVerdicts([
      [
        "repeated delivery",
        trace([batch(initial), batch(reviewed), batch(accepted), batch([delivered])]),
        false,
      ],
      [
        "delivery to the previous Lead",
        trace([batch(initial), batch(reviewed), batch([handover, delivered])]),
        false,
      ],
    ]);
  });

  test.concurrent("handover requests replay in order; cancelled or superseded completions are rejected", async () => {
    const request = (id: string) =>
      E.LeadHandoverRequested.make({
        ...graph,
        requestId: id,
        from: lead,
        summary: "",
        interrupt: false,
      });

    const changed = (id: string) =>
      E.LeadChanged.make({
        ...graph,
        requestId: id,
        from: lead,
        to: SessionId.make("next-lead"),
        summary: "Continue",
      });

    const cancelled = E.LeadHandoverCancelled.make({
      ...graph,
      requestId: "r1",
      reason: "Archived",
    });

    await expectVerdicts([
      [
        "r1 completes",
        trace([batch(initial), batch([request("r1")]), batch([changed("r1")])]),
        true,
      ],
      [
        "cancelled r1 completes",
        trace([batch(initial), batch([request("r1"), cancelled]), batch([changed("r1")])]),
        false,
      ],
      [
        "superseded r1 completes",
        trace([batch(initial), batch([request("r1"), request("r2")]), batch([changed("r1")])]),
        false,
      ],
      [
        "superseding r2 completes",
        trace([batch(initial), batch([request("r1"), request("r2")]), batch([changed("r2")])]),
        true,
      ],
    ]);
  });

  test.concurrent("stale intervals and per-recipient input receipts replay without an Attempt revision bump", async () => {
    const stale = E.AttemptStale.make({ ...graph, attemptId, hostId: host, at: time });
    const fresh = E.AttemptFresh.make({ ...graph, attemptId, at: time });

    const delivered = E.WorkerInputDelivered.make({
      ...graph,
      id: "message",
      sessionId: worker,
      at: time,
    });

    await expectVerdicts([
      [
        "stale, fresh, delivered",
        trace([batch(initial), batch([began]), batch([stale, fresh, delivered])]),
        true,
      ],
      [
        "delivered twice",
        trace([batch(initial), batch([began]), batch([delivered, delivered])]),
        false,
      ],
    ]);
  });

  test("ownership is checked even for metadata omitted from the abstraction", () => {
    const message = E.PeerMessage.make({ ...graph, from: attemptId, to: attemptId, text: "Hello" });
    expect(() =>
      constellationTraceToQuint(
        "bad",
        trace([{ hostId: "foreign-host", events: [message] }]),
        "model"
      )
    ).toThrow("owner");
  });

  test.concurrent("stale settlement requires explicit context and cannot be mechanical", async () => {
    const settled = E.AttemptSettled.make({
      ...target,
      outcome: "lost",
      reason: "Host is Offline",
    });

    const events = [settled, notification("lost", "lost")];
    expect(() =>
      constellationTraceToQuint(
        "bad",
        trace([batch(initial), batch([began]), batch(events)]),
        "model"
      )
    ).toThrow("batch.context");
    const context = { offlineSessionIds: [worker], commanded: true };
    await expectVerdicts([
      ["commanded", trace([batch(initial), batch([began]), { ...batch(events), context }]), true],
      [
        "mechanical",
        trace([
          batch(initial),
          batch([began]),
          { ...batch(events), context: { ...context, commanded: false } },
        ]),
        false,
      ],
    ]);
  });

  test.concurrent("remote receipt reapplication is rejected", async () => {
    await expectVerdicts([
      ["applied once", trace([batch(initial), { ...batch(reviewed), outboxId: "remote:1" }]), true],
      [
        "reapplied",
        trace([
          batch(initial),
          { ...batch(reviewed), outboxId: "remote:1" },
          {
            ...batch([E.OperatorMessageResolved.make({ ...graph, id: "m" })]),
            outboxId: "remote:1",
          },
        ]),
        false,
      ],
    ]);
  });

  test.concurrent("Host resource streams use their own owner and capacity", async () => {
    const remote = HostId.make("worker-host");
    const resource = new HostResource({ hostId: remote, name: "bench", capacity: 1 });

    const queued = (id: string) =>
      E.ResourceLeaseQueued.make({ hostId: remote, resource: resource.name, requestId: id });

    const leased = (id: string) =>
      E.ResourceLeased.make({
        lease: new ResourceLease({
          id,
          hostId: remote,
          resource: resource.name,
          command: ["bun", "run", "bench"],
          processId: 123,
          acquiredAt: time,
        }),
      });

    const events = [
      E.ResourceDeclared.make({ resource }),
      queued("r1"),
      queued("r2"),
      leased("r1"),
    ];

    const cancel = ResourceLeaseCanceled.make({
      hostId: remote,
      resource: resource.name,
      requestId: "r2",
      reason: "Requester exited",
    });

    const removed = ResourceRemoved.make({ hostId: remote, resource: resource.name });

    const released = E.ResourceReleased.make({
      hostId: remote,
      resource: resource.name,
      leaseId: "r1",
      reason: "Process exited",
    });

    const stream = (events: ConstellationTrace["batches"][number]["events"]) =>
      trace([{ hostId: remote, events }]);

    await expectVerdicts([
      ["r1 leased", stream(events), true],
      ["r2 canceled, r1 released, removed", stream([...events, cancel, released, removed]), true],
      ["removed with holders", stream([...events, removed]), false],
      ["over capacity", stream([...events, leased("r2")]), false],
      ["out of order", stream([events[0]!, queued("r1"), queued("r2"), leased("r2")]), false],
    ]);
  });
});

test.concurrent("recovery replay requires eligible proof for the exact interruption ID", async () => {
  const proof = E.AttemptInterrupted.make({
    ...graph,
    attemptId,
    turnId: TurnId.make("interrupted"),
    interruptionId: "cut-1",
    eligible: true,
    at: time,
  });

  const recovered = E.AttemptRecoveryContinued.make({
    ...target,
    turnId: TurnId.make("continued"),
    interruptionId: "cut-1",
    cause: "recover",
  });

  const start = batch([...initial, began]);

  await expectVerdicts([
    ["eligible proof", trace([start, batch([proof]), batch([recovered])]), true],
    ["no proof", trace([start, batch([recovered])]), false],
    [
      "ineligible proof",
      trace([
        start,
        batch([E.AttemptInterrupted.make({ ...proof, eligible: false })]),
        batch([recovered]),
      ]),
      false,
    ],
    [
      "another interruption ID",
      trace([
        start,
        batch([proof]),
        batch([E.AttemptRecoveryContinued.make({ ...recovered, interruptionId: "cut-2" })]),
      ]),
      false,
    ],
  ]);
});

test("unblock replay requires a Lead input sent after the block", () => {
  const f = unblockFixture();

  const source = (before: boolean) =>
    constellationTraceToQuint(
      "fresh_block",
      trace([
        batch(initial),
        batch([began]),
        ...(before
          ? [batch([E.OperatorMessageSent.make({ ...f.message, revision: 1 })]), batch([f.blocked])]
          : [batch([f.blocked]), batch([f.message])]),
        batch([f.turn, f.unblocked, f.delivered]),
      ]),
      "constellations"
    )[0]!.source;

  expect(source(true)).toContain('cause: "Lead", turn: true, fresh: false');
  expect(source(false)).toContain('cause: "Lead", turn: true, fresh: true');
});

test.concurrent("unblock replay rejects a fresh broadcast as its Lead cause", async () => {
  const f = unblockFixture();

  const broadcast = E.OperatorMessageSent.make({
    ...f.message,
    target: MessageTarget.cases.All.make({}),
  });

  const input = trace([
    batch(initial),
    batch([began]),
    batch([f.blocked]),
    batch([broadcast]),
    batch([f.turn, f.unblocked, f.delivered]),
  ]);

  expect(constellationTraceToQuint("broadcast", input, "constellations")[0]!.source).toContain(
    'cause: "Lead", turn: true, fresh: false'
  );
  expect(await check(input)).toBe(false);
});

test.concurrent("quoted multiline feedback and merge base replay safely; actual first Turns reject duplicates", async () => {
  const reason = 'Keep "both tests".\n\nUnicode λ and \\ literal escape.';

  const retry = E.AttemptStarted.make({
    ...graph,
    attempt: Attempt.make(
      Struct.assign(began.attempt, {
        id: AttemptId.make("retry"),
        hostId: HostId.make("remote-worker"),
        cause: AttemptCause.cases.MergeConflict.make({ ref: attemptId, base: 'base"\nmerge' }),
      })
    ),
  });

  const rejected = E.AttemptRejected.make({ ...target, reason });

  const first = E.TurnStarted.make({
    turn: Turn.make({
      id: TurnId.make("retry:start"),
      sessionId: worker,
      index: 0,
      prompt: reason,
      attachments: [],
      model: null,
      effort: null,
      status: "working",
      checkpointBefore: null,
      checkpointAfter: null,
      startedAt: time,
      endedAt: null,
    }),
  });

  const batches = [
    batch(initial),
    batch(reviewed),
    batch([rejected, retry]),
    { hostId: "remote-worker", events: [first] },
  ];

  expect(() =>
    constellationTraceToQuint("first", trace([...batches.slice(0, -1), batch([first])]), "model")
  ).toThrow("worker Host");
  const sources = constellationTraceToQuint("first", trace(batches), "model");
  expect(sources[0]!.source).toContain("FirstTurnStarted(1)");

  await expectVerdicts([
    ["first Turn on the worker Host", trace(batches), true],
    ["first Turn twice", trace([...batches, batches.at(-1)!]), false],
  ]);
});

test.concurrent("first-Turn trace validation rejects blocked, review and settled Attempts", async () => {
  const first = E.TurnStarted.make({
    turn: Turn.make({
      id: TurnId.make(`${attemptId}:start`),
      sessionId: worker,
      index: 0,
      prompt: "Brief",
      attachments: [],
      model: null,
      effort: null,
      status: "working",
      checkpointBefore: null,
      checkpointAfter: null,
      startedAt: time,
      endedAt: null,
    }),
  });

  const blocked = E.AttemptBlocked.make({ ...target, on: [], reason: "Wait", at: time });

  await expectVerdicts([
    ["working", trace([batch(initial), batch([began]), batch([first])]), true],
    ["blocked", trace([batch(initial), batch([began]), batch([blocked]), batch([first])]), false],
    ["review", trace([batch(initial), batch(reviewed), batch([first])]), false],
    ["settled", trace([batch(initial), batch(reviewed), batch(accepted), batch([first])]), false],
  ]);
});

test.concurrent("re-claim trace preserves earlier Claim and rejects the old head on acceptance", async () => {
  const nextClaim = Claim.make(Struct.assign(claim, { head: "head-2", commits: ["head-2"] }));

  const reClaim = [
    E.AttemptClaimed.make({ ...target, attemptRevision: 3, claim: nextClaim }),
    notification("fresh-review", "review"),
  ];

  const newAccept = E.AttemptAccepted.make({
    ...target,
    attemptRevision: 4,
    mergedHead: "head-2",
    receipts: [],
    evidence: "asserted",
  });

  await expectVerdicts([
    [
      "new head accepted",
      trace([batch(initial), batch(reviewed), batch(reClaim), batch([newAccept])]),
      true,
    ],
    [
      "old head accepted",
      trace([batch(initial), batch(reviewed), batch(reClaim), batch(accepted)]),
      false,
    ],
  ]);
});
