/**
 * The C1 graph for previews: "Constellations v1" as Paper draws it, with a handover, a
 * digest, Claims with receipts, a remote worker, a stopped worker, a proposal and a Future.
 */
import {
  OpenQuestion,
  Attempt,
  AttemptCause,
  AttemptId,
  CheckReceipt,
  Claim,
  Constellation,
  ConstellationId,
  ConstellationNotification,
  ConstellationQuestion,
  ConstellationSettings,
  HarnessSelection,
  HostId,
  MessageTarget,
  NotificationItem,
  SessionId,
  Task,
  TaskId,
  ToolCallReference,
  TurnId,
  WorkerActivity,
  WorkerLiveness,
  WorkspaceId,
} from "@polaris/protocol";
import { merged, startedRecord } from "../model/fold.ts";
import { questionsIn } from "../model/questions.ts";
import type { ConstellationRecord, ProjectionData } from "../model/index.ts";

export const STUDIO = HostId.make("h-studio");

export const DEVBOX = HostId.make("h-devbox");

export const WORKSPACE = WorkspaceId.make("w-polaris");

export const LEAD = SessionId.make("s-lead");

export const PREVIOUS_LEAD = SessionId.make("s-lead-0");

export const CONSTELLATION = ConstellationId.make("c-v1");

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export const worker = (taskId: string) => SessionId.make(`s-${taskId.toLowerCase()}`);

const codex = new HarnessSelection({ harness: "codex", model: "gpt-6.1-sol", effort: "high" });

const claude = new HarnessSelection({ harness: "claude", model: "opus", effort: "high" });

interface TaskSpec {
  readonly id: string;
  readonly title: string;
  readonly group?: string | null;
  readonly deps?: ReadonlyArray<string>;
  readonly area?: ReadonlyArray<string>;
  readonly kind?: "task" | "gate";
  readonly brief?: string;
  readonly ui?: boolean;
  readonly parent?: string;
}

export const task = (spec: TaskSpec) =>
  new Task({
    id: TaskId.make(spec.id),
    title: spec.title,
    kind: spec.kind ?? "task",
    deps: (spec.deps ?? []).map((d) => TaskId.make(d)),
    area: [...(spec.area ?? [])],
    brief: spec.brief ?? `Carry out ${spec.title.toLowerCase()} and claim when the checks pass.`,
    criteria: [],
    suggested: spec.kind === "gate" ? null : spec.ui === true ? claude : codex,
    group: spec.group ?? null,
    parent: spec.parent === undefined ? null : TaskId.make(spec.parent),
    revision: 1,
    canceled: false,
  });

const verified = (label: string, item: string, session: SessionId = LEAD) =>
  CheckReceipt.cases.Verified.make({
    label,
    item: new ToolCallReference({
      hostId: STUDIO,
      sessionId: session,
      turnId: TurnId.make("t-x"),
      itemId: item,
    }),
  });

const reported = (label: string, text: string) =>
  CheckReceipt.cases.Reported.make({ label, text, command: null, exitCode: null });

interface AttemptSpec {
  readonly taskId: string;
  readonly state: Attempt["state"];
  readonly minutes: number;
  readonly host?: HostId;
  readonly session?: SessionId;
  readonly claim?: Claim | null;
  readonly mergedHead?: string | null;
  readonly receipts?: ReadonlyArray<CheckReceipt>;
  readonly evidence?: Attempt["evidence"];
  readonly n?: number;
  readonly nudgedMinutesAgo?: number;
  /** A blocked Attempt's targets and reason. */
  readonly blocked?: { readonly on: ReadonlyArray<string>; readonly reason: string };
  /** A failed settle's kind, reason and Plan Limit reset. */
  readonly failure?: {
    readonly kind: Attempt["failureKind"];
    readonly reason: string;
    readonly resetsAt?: string;
  };
}

export const attempt = (spec: AttemptSpec) =>
  new Attempt({
    id: AttemptId.make(`att-${spec.taskId}-${spec.n ?? 1}`),
    taskId: TaskId.make(spec.taskId),
    revision: 2,
    cause: AttemptCause.cases.Initial.make({}),
    by: LEAD,
    sessionId: spec.session ?? worker(spec.taskId),
    hostId: spec.host ?? STUDIO,
    worktree: `/Users/lucas/code/polaris.worktrees/const-v1/${spec.taskId}`,
    branch: `polaris/const-v1/${spec.taskId}-${spec.taskId === "B1" ? "quint" : "work"}`,
    base: "8e41d07c2",
    state: spec.state,
    claim: spec.claim ?? null,
    mergedHead: spec.mergedHead ?? null,
    receipts: [...(spec.receipts ?? [])],
    evidence: spec.evidence ?? null,
    claimedAt: spec.claim == null ? null : ago(Math.max(1, spec.minutes - 30)),
    approvedByUserAt: null,
    handedUpAt: null,
    handedUpReason: null,
    nudgedAt: spec.nudgedMinutesAgo === undefined ? null : ago(spec.nudgedMinutesAgo),
    blockedOn: (spec.blocked?.on ?? []).map((id) => TaskId.make(id)),
    blockedReason: spec.blocked?.reason ?? null,
    blockedAt: spec.blocked === undefined ? null : ago(Math.max(1, spec.minutes - 5)),
    settleReason: spec.failure?.reason ?? null,
    failureKind: spec.failure?.kind ?? null,
    resetsAt: spec.failure?.resetsAt ?? null,
    startedAt: ago(spec.minutes),
    endedAt:
      spec.state === "working" || spec.state === "review" || spec.state === "blocked"
        ? null
        : ago(spec.minutes - 20),
  });

export const B1_QUESTION = new ConstellationQuestion({
  id: "q-b1",
  to: "lead",
  text: "May two leads overlap during a handover?",
  blocking: false,
});

export const b1Claim = new Claim({
  branch: "polaris/const-v1/B1-quint",
  head: "3f9c2e1a77",
  commits: ["3f9c2e1", "a0b1c2d", "d4e5f6a", "17a8b9c", "c0d1e2f", "9a8b7c6"],
  receipts: [
    verified("spec", "i-spec", worker("B1")),
    verified("tests", "i-tests", worker("B1")),
    verified("trace", "i-trace", worker("B1")),
  ],
  notDone: ["Trace for handover (needs B5)"],
  followups: [],
  questions: [B1_QUESTION],
  outsideArea: [],
  decisions: ["Properties live in polaris.qnt"],
  summary: "Seven of the eight properties hold; trace validation fails on the handover log.",
});

const b4Claim = new Claim({
  branch: "polaris/const-v1/B4-work",
  head: "51c0ffee9",
  commits: ["51c0ffe", "2b3c4d5"],
  receipts: [reported("endpoint", "curl round-trips on devbox")],
  notDone: [],
  followups: [],
  questions: [],
  outsideArea: [],
  decisions: [],
  summary: "Streamable-HTTP endpoint with per-session tokens.",
});

const A = "A · Events and decider";

export const B = "B · Spec and tools";

export const c1Tasks = [
  task({
    id: "A1",
    title: "Constellation events and stream",
    group: A,
    area: ["packages/protocol/**"],
  }),
  task({
    id: "A2",
    title: "Decider and projections",
    group: A,
    deps: ["A1"],
    area: ["apps/daemon/src/engine/**"],
  }),
  task({ id: "G1", title: "Engine merged to main", group: A, kind: "gate", deps: ["A1", "A2"] }),
  task({
    id: "B1",
    title: "Quint properties",
    group: B,
    deps: ["A2"],
    area: ["packages/spec/**"],
    brief:
      "Write the eight Quint properties from ENG-236 and wire trace validation. Claim when the spec checks pass.",
  }),
  task({
    id: "B2",
    title: "Lead and worker MCP tools",
    group: B,
    deps: ["G1"],
    area: ["apps/daemon/src/mcp/**"],
  }),
  task({
    id: "B3",
    title: "Tool eval on the bench harness",
    group: B,
    deps: ["G1"],
    area: ["apps/daemon/src/mcp/**", "packages/bench/**"],
  }),
  task({
    id: "B4",
    title: "Streamable-HTTP endpoint",
    group: B,
    deps: ["G1"],
    area: ["apps/daemon/src/transport/**"],
  }),
  task({
    id: "B5",
    title: "Trace validation for handover",
    group: B,
    deps: ["A2"],
    area: ["apps/daemon/src/verification/**"],
  }),
  task({
    id: "G2",
    title: "Spec and tools merged",
    group: B,
    kind: "gate",
    deps: ["B1", "B2", "B3", "B4", "B5"],
  }),
  task({ id: "C1", title: "C · Constellation tab in the Desktop App", ui: true, deps: ["G2"] }),
];

/** Tasks with slug ids in lowercase groups, as Leads name them: the id lane has to fit these. */
export const slugTasks = [
  task({
    id: "handoff-hardening",
    title: "Harden the handoff summary",
    group: "daemon",
    area: ["apps/daemon/src/engine/handoff/**"],
  }),
  task({
    id: "worktree-setup-retry-on-reconnect",
    title: "Retry worktree setup when a Host reconnects",
    group: "daemon",
  }),
  task({ id: "email-validator", title: "Validate the download email", group: "desktop", ui: true }),
  task({ id: "sidebar-groups", title: "Group the sidebar by task", group: "desktop", ui: true }),
  task({ id: "blocked", title: "Show blocked tasks on the rail", group: "desktop", ui: true }),
];

export const UPDATES = "F · Updates";

/** A parent F two levels deep: F1 holds F1a and F1b; F2 is blocked by F1b, F3 on the Lead. */
export const treeTasks = [
  task({ id: "F", title: "Update feed and updater", group: UPDATES, deps: ["G1"] }),
  task({ id: "F1", title: "Signed update feed", group: UPDATES, parent: "F" }),
  task({ id: "F1a", title: "Feed schema", group: UPDATES, parent: "F1" }),
  task({
    id: "F1b",
    title: "Sign and serve the feed",
    group: UPDATES,
    parent: "F1",
    deps: ["F1a"],
  }),
  task({ id: "F2", title: "Updater polls the feed", group: UPDATES, parent: "F", ui: true }),
  task({ id: "F3", title: "Release notes in the updater", group: UPDATES, parent: "F", ui: true }),
];

export const treeAttempts = [
  attempt({
    taskId: "F1a",
    state: "accepted",
    minutes: 70,
    mergedHead: "f1a2b3c",
    evidence: "verified",
  }),
  attempt({ taskId: "F1b", state: "working", minutes: 24 }),
  attempt({
    taskId: "F2",
    state: "blocked",
    minutes: 20,
    blocked: { on: ["F1b"], reason: "Needs the signed feed URL to poll" },
  }),
  attempt({
    taskId: "F3",
    state: "blocked",
    minutes: 16,
    blocked: { on: [], reason: "Markdown or the site's MDX for the notes?" },
  }),
];

const emailClaim = new Claim({
  branch: "polaris/const-v1/email-validator-work",
  head: "7d2e9b41c",
  commits: ["7d2e9b4", "1f0a3c2"],
  receipts: [verified("tests", "i-email-tests", worker("email-validator"))],
  notDone: [],
  followups: [],
  questions: [],
  outsideArea: [],
  decisions: [],
  summary: "MX check before sending; Gmail's MEDIUM verdict is accepted.",
});

export const slugAttempts = [
  attempt({ taskId: "handoff-hardening", state: "working", minutes: 22 }),
  attempt({
    taskId: "worktree-setup-retry-on-reconnect",
    state: "working",
    minutes: 14,
    nudgedMinutesAgo: 4,
  }),
  attempt({ taskId: "email-validator", state: "review", minutes: 30, claim: emailClaim }),
  attempt({ taskId: "blocked", state: "working", minutes: 12 }),
  attempt({
    taskId: "sidebar-groups",
    state: "accepted",
    minutes: 90,
    mergedHead: "5e6f7a8",
    evidence: "verified",
  }),
];

export const c1Attempts = [
  attempt({
    taskId: "A1",
    state: "accepted",
    minutes: 180,
    mergedHead: "aa11bb2",
    evidence: "verified",
  }),
  attempt({
    taskId: "A2",
    state: "accepted",
    minutes: 150,
    mergedHead: "cc33dd4",
    evidence: "verified",
  }),
  attempt({
    taskId: "G1",
    state: "accepted",
    minutes: 120,
    session: LEAD,
    mergedHead: "8e41d07c2",
    receipts: [
      verified("test", "i-g1-test"),
      verified("spec", "i-g1-spec"),
      reported("smoke on Pi", "smoke passed on lucas-rpi"),
    ],
    evidence: "verified",
  }),
  attempt({ taskId: "B1", state: "review", minutes: 41, claim: b1Claim }),
  attempt({ taskId: "B2", state: "working", minutes: 31 }),
  attempt({ taskId: "B3", state: "working", minutes: 18 }),
  attempt({ taskId: "B4", state: "review", minutes: 52, host: DEVBOX, claim: b4Claim }),
  attempt({ taskId: "B5", state: "working", minutes: 37, nudgedMinutesAgo: 6 }),
];

const note = (id: string, item: NotificationItem, minutes: number) =>
  new ConstellationNotification({ id, item, queuedAt: ago(minutes) });

export const digestItems = [
  note(
    "n-b1",
    NotificationItem.cases.Settled.make({ attemptId: AttemptId.make("att-B1-1"), state: "review" }),
    3
  ),
  note(
    "n-b2",
    NotificationItem.cases.Proposal.make({
      attemptId: AttemptId.make("att-B2-1"),
      proposalId: "p-lease",
    }),
    2
  ),
];

export const pendingQuestion = note(
  "n-q-b1",
  NotificationItem.cases.Question.make({
    attemptId: AttemptId.make("att-B1-1"),
    question: B1_QUESTION,
  }),
  3
);

const settings = new ConstellationSettings({
  branchPrefix: "polaris/const-v1",
  transfer: "bundle",
  defaults: null,
  backend: codex,
  ui: claude,
});

export const constellationOf = (patch: Partial<Constellation> = {}) =>
  new Constellation({
    id: CONSTELLATION,
    workspaceId: WORKSPACE,
    hostId: STUDIO,
    leadSessionId: LEAD,
    name: "Constellations v1",
    state: "running",
    revision: 37,
    settings,
    tasks: c1Tasks,
    attempts: c1Attempts,
    pendingNotifications: [pendingQuestion],
    createdAt: ago(240),
    updatedAt: ago(1),
    ...patch,
    openQuestions:
      patch.openQuestions ?? questionsIn(patch.pendingNotifications ?? [pendingQuestion]),
  });

/** B4's branch hasn't come back from devbox: the Daemon's projection says so. */
const unfetched = (projections: ReadonlyArray<ProjectionData>) =>
  projections.map((p) => (p.taskId === "B4" ? { ...p, branchFetched: false } : p));

/** B2 as the Daemon observes it: running the bench for 4 minutes, nothing queued. */
const b2Liveness = () =>
  new WorkerLiveness({
    current: new WorkerActivity({
      itemId: "i-bench",
      turnId: TurnId.make("t-b2"),
      command: "bun run bench",
      startedAt: Date.now() - 4 * 60_000,
    }),
    lastOutputAt: Date.now() - 20_000,
    contextPercent: 61,
    queuedInput: 0,
  });

/** A completed Constellation: every Attempt accepted with its merged head. */
export const completedAttempts = () =>
  c1Attempts.map(
    (a) =>
      new Attempt(
        merged(a, {
          state: "accepted",
          mergedHead: a.mergedHead ?? "9a8b7c6",
          evidence: a.evidence ?? "verified",
          endedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        })
      )
  );

/** C3: the Lead handed B1's Claim up because it can't decide the question. */
/** B1's Claim handed up to the user; `approved`: and the user has since approved it. */
export const handedUpAttempts = (approved = false) =>
  c1Attempts.map((a) =>
    a.taskId === "B1"
      ? new Attempt(
          merged(a, {
            handedUpAt: new Date(Date.now() - 2 * 60_000).toISOString(),
            handedUpReason: "it can't decide the question",
            approvedByUserAt: approved ? new Date(Date.now() - 60_000).toISOString() : null,
          })
        )
      : a
  );

export const c1Record = (
  patch: Partial<Constellation> = {},
  digestTurn = "t-lead-digest"
): ConstellationRecord => {
  const base = startedRecord(constellationOf(patch), 120);
  const handoverAt = ago(36);

  return {
    ...base,
    projections: unfetched(base.projections).map((p) => {
      return p.taskId === "B2" ? merged(p, { liveness: b2Liveness() }) : p;
    }),
    proposals: [
      {
        proposalId: "p-lease",
        by: AttemptId.make("att-B2-1"),
        task: {
          id: TaskId.make("B6"),
          title: "Lease bench and smoke",
          kind: "task",
          deps: [],
          area: ["packages/bench/**"],
          brief: "",
          criteria: [],
          suggested: null,
          group: B,
          parent: null,
        },
        at: ago(2),
      },
    ],
    handovers: [
      {
        from: PREVIOUS_LEAD,
        to: LEAD,
        summary:
          "Events and the decider are merged (G1, verified). B is in flight: the MCP tools and the eval share the bench, so B3 waits on B2. B4 runs on devbox and will need its branch fetched. B1 should land before B5 because the handover trace depends on its properties.",
        revision: 37,
        at: handoverAt,
        projections: unfetched(base.projections).map((p) => {
          if (p.taskId === "B1") return merged(p, { state: "working" });

          return p.taskId === "B4" ? merged(p, { state: "working" }) : p;
        }),
        inFlight: [AttemptId.make("att-B2-1"), AttemptId.make("att-B4-1")],
        questions: [
          note(
            "n-q-b2",
            NotificationItem.cases.Question.make({
              attemptId: AttemptId.make("att-B2-1"),
              question: new ConstellationQuestion({
                id: "q-b2",
                to: "lead",
                text: "Run bench on devbox or wait for the Mac Studio lock?",
                blocking: true,
              }),
            }),
            40
          ),
        ],
        undelivered: [
          {
            id: "m-b4",
            authority: "conversation",
            target: MessageTarget.cases.Worker.make({ attemptId: AttemptId.make("att-B4-1") }),
            text: "Use the per-Host token URL, not stdio.",
            at: ago(37),
          },
        ],
      },
    ],
    digests: [
      {
        turnId: TurnId.make(digestTurn),
        leadSessionId: LEAD,
        revision: 36,
        at: ago(3),
        items: [...digestItems],
      },
    ],
  };
};

/**
 * The digest's slug and tree lines: a question from `blocked`, an answer and a Claim from
 * email-validator, F2 blocked by F1b and F3 waiting on the Lead.
 */
const slugDigest = [
  note(
    "n-blocked-f2",
    NotificationItem.cases.Blocked.make({
      taskId: TaskId.make("F2"),
      attemptId: AttemptId.make("att-F2-1"),
      on: [TaskId.make("F1b")],
      reason: "Needs the signed feed URL to poll",
    }),
    4
  ),
  note(
    "n-blocked-f3",
    NotificationItem.cases.Blocked.make({
      taskId: TaskId.make("F3"),
      attemptId: AttemptId.make("att-F3-1"),
      on: [],
      reason: "Markdown or the site's MDX for the notes?",
    }),
    3
  ),
  note(
    "n-q-blocked",
    NotificationItem.cases.Question.make({
      attemptId: AttemptId.make("att-blocked-1"),
      question: new ConstellationQuestion({
        id: "q-blocked",
        to: "lead",
        text: "Should a blocked Task keep its working glyph while it waits?",
        blocking: false,
      }),
    }),
    2
  ),
  note(
    "n-a-email",
    NotificationItem.cases.QuestionAnswered.make({
      attemptId: AttemptId.make("att-email-validator-1"),
      questionId: "q-email",
      text: "Accept Gmail's MEDIUM verdict; reject LOW.",
    }),
    2
  ),
  note(
    "n-email",
    NotificationItem.cases.Settled.make({
      attemptId: AttemptId.make("att-email-validator-1"),
      state: "review",
    }),
    1
  ),
];

/** C1 with the slug Tasks and the F tree added, and the digest reporting on them. */
export const slugRecord = (patch: Partial<Constellation> = {}): ConstellationRecord => {
  const record = c1Record({
    ...patch,
    tasks: [...c1Tasks, ...slugTasks, ...treeTasks],
    attempts: [...(patch.attempts ?? c1Attempts), ...slugAttempts, ...treeAttempts],
  });

  return {
    ...record,
    digests: record.digests.map((d) => ({ ...d, items: [...d.items, ...slugDigest] })),
  };
};

/** Two workers asking the user, as the Lead chat pins them above its composer (ENG-345). */
export const askedYou = (): Array<OpenQuestion> => [
  new OpenQuestion({
    attemptId: AttemptId.make("att-B1-1"),
    question: new ConstellationQuestion({
      id: "q-b1-user",
      to: "user",
      text: "May two leads overlap during a handover, or should the old lead stop first?",
      blocking: true,
    }),
    askedAt: ago(6),
  }),
  new OpenQuestion({
    attemptId: AttemptId.make("att-B3-1"),
    question: new ConstellationQuestion({
      id: "q-b3-user",
      to: "user",
      text: "Keep the bench on the Pi, or move it to the small VM?",
      blocking: false,
    }),
    askedAt: ago(2),
  }),
];
