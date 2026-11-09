/**
 * The Constellation tab on fixtures, for screenshots against Paper C1–C9: `#constellation/<scene>`
 * renders the real shell on a stand-in store and a fake Daemon. Its own chunk.
 */
import { Capability, constellationSummaryOf, HostId, Sequence, TurnId } from "@polaris/protocol";
import { createRoot } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import type { HostView, PolarisApi } from "../../../../shared/api.ts";
import { App } from "../../../app/App.tsx";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { modelFromSnapshot } from "../../../store/hostModel.ts";
import type { SessionModel } from "../../../store/sessionModel.ts";
import { type AppState, type Connection, initialState, sessionKey } from "../../../store/store.ts";
import { standInBridge } from "../../bridge.ts";
import { showOutput } from "../../session/index.ts";
import { installConstellationClient } from "../client.ts";
import { type ConstellationRecord, startedRecord, type WorkerFacts } from "../model/index.ts";
import { type LeadUi, leadKey, patchLeadUi, setSignals } from "../state.ts";
import { fakeClient } from "./fakeClient.ts";
import {
  askedYou,
  c1Record,
  constellationOf,
  DEVBOX,
  completedAttempts,
  handedUpAttempts,
  LEAD,
  slugRecord,
  STUDIO,
  WORKSPACE,
} from "./graph.ts";
import { FAILURE_SIGNALS, failuresRecord } from "./failures.ts";
import { STARTUP_SIGNALS, withStartupSetups } from "./startup.ts";
import { chromeRecord } from "./chrome.ts";
import { largeRecord } from "./large.ts";
import { worstRecords } from "./worst.ts";
import { b8Model, setupRecord, setupSessions } from "./setup.ts";
import { statsFixture } from "./stats.ts";
import {
  b1Model,
  LATER_DIGEST_TURN,
  leadModel,
  leadModelSteered,
  leadModelWithLaterDigest,
  STEERED_TURN,
  leadSession,
  previousLead,
  workerSessions,
  workspace,
  worktree,
} from "./sessions.ts";

const LOCAL = "local";

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const host = (
  key: string,
  label: string,
  hostId: string,
  state: "connected" | "reconnecting"
): HostView => ({
  key,
  label,
  colour: null,
  alias: key === LOCAL ? null : key,
  kind: key === LOCAL ? "local" : "ssh",
  proofHarness: false,
  status: {
    state,
    failure: null,
    attempt: 0,
    since: Date.now() - 120_000,
    nextAttemptAt: null,
    host: {
      hostId: HostId.make(hostId),
      hostname: key,
      platform: "darwin-arm64",
      daemonVersion: "0.0.0",
      homeDir: "/Users/lucas",
      startedAt: "2026-09-29T00:00:00.000Z",
    },
    capabilities: Capability.literals,
    epoch: 1,
    latencyMs: null,
    lastSeenAt: null,
  },
});

const SCENES = [
  "lead",
  "menu",
  "focus",
  "handed",
  "handed-unmerged",
  "handed-menu",
  "handed-approved",
  "paused",
  "empty",
  "large",
  "handover",
  "stats",
  "completed",
  "setup",
  "setup-focus",
  "slugs",
  "tree",
  "digests",
  "failures",
  "steered",
  "startup",
  "asks-you",
  "chrome",
  "worst-one",
  "worst-80",
  "worst-failed",
  "worst-accepted",
  "worst-cycle",
] as const;

type Scene = (typeof SCENES)[number];

const FIXED: Partial<Record<Scene, () => ConstellationRecord>> = {
  large: largeRecord,
  chrome: chromeRecord,
  failures: failuresRecord,
  ...worstRecords,
};

const recordFor = (scene: Scene): ConstellationRecord => {
  const fixed = FIXED[scene];

  if (fixed !== undefined) return fixed();

  if (scene === "empty")
    return startedRecord(
      constellationOf({ state: "planning", tasks: [], attempts: [], pendingNotifications: [] }),
      3
    );

  if (scene === "handed" || scene === "handed-unmerged")
    return slugRecord({ attempts: handedUpAttempts() });

  if (scene === "handed-menu") return c1Record({ attempts: handedUpAttempts() });

  if (scene === "handed-approved") return slugRecord({ attempts: handedUpAttempts(true) });

  if (scene === "setup" || scene === "setup-focus") return setupRecord();

  if (scene === "asks-you") return slugRecord({ openQuestions: askedYou() });

  if (scene === "completed") return c1Record({ state: "completed", attempts: completedAttempts() });

  if (scene === "digests") {
    const record = slugRecord();
    const [first] = record.digests;

    return first === undefined
      ? record
      : {
          ...record,
          digests: [
            ...record.digests,
            {
              ...first,
              turnId: TurnId.make(LATER_DIGEST_TURN),
              revision: first.revision + 2,
              items: first.items.slice(1, 2),
            },
          ],
        };
  }

  if (scene === "steered") {
    const record = slugRecord();
    const [first] = record.digests;

    return first === undefined
      ? record
      : {
          ...record,
          digests: [
            ...record.digests,
            {
              ...first,
              turnId: TurnId.make(STEERED_TURN),
              steered: true,
              at: new Date().toISOString(),
            },
          ],
        };
  }

  return slugRecord(scene === "paused" ? { state: "paused" } : {});
};

/** Group A is done; folding it keeps B7 and B8 in view. */
const SETUP_FOLDS = new Map([["A · Events and decider", false]]);

/** A and B folded, so the slug ids in "daemon" and "desktop" are in view. */
const SLUG_FOLDS = new Map([
  ["A · Events and decider", false],
  ["B · Spec and tools", false],
]);

/** A, B and daemon folded, so the F tree and its blocked Tasks are in view. */
const TREE_FOLDS = new Map([
  ["A · Events and decider", false],
  ["B · Spec and tools", false],
  ["daemon", false],
]);

const UI: Readonly<Record<Scene, Partial<LeadUi>>> = {
  lead: {},
  "asks-you": {},
  digests: {},
  failures: {},
  steered: {},
  startup: { selected: "task:B2" },
  menu: { selected: "task:B1", menu: "task:B1" },
  focus: { focus: { kind: "task", taskId: "B1" }, selected: "task:B1" },
  handed: { focus: { kind: "task", taskId: "B1" }, selected: "task:B1" },
  "handed-unmerged": {
    focus: { kind: "task", taskId: "B1" },
    selected: "task:B1",
    review: { attemptId: "att-B1-1", mode: "accept" },
  },
  "handed-menu": { selected: "task:B1", menu: "task:B1" },
  "handed-approved": { focus: { kind: "task", taskId: "B1" }, selected: "task:B1" },
  paused: {},
  empty: {},
  large: { selected: "task:C5" },
  handover: { focus: { kind: "handover", revision: 37 }, selected: "handover:37" },
  stats: { stats: true },
  completed: {},
  setup: { selected: "task:B8", folds: SETUP_FOLDS },
  "setup-focus": {
    focus: { kind: "task", taskId: "B8" },
    selected: "task:B8",
    folds: SETUP_FOLDS,
  },
  slugs: { selected: "task:email-validator", folds: SLUG_FOLDS },
  tree: { selected: "task:F2", folds: TREE_FOLDS },
  chrome: {},
  "worst-one": {},
  "worst-80": {},
  "worst-failed": {},
  "worst-accepted": {},
  "worst-cycle": {},
};

const LEADS = new Map<Scene, () => SessionModel>([
  ["digests", leadModelWithLaterDigest],
  ["steered", leadModelSteered],
]);

const stateFor = (record: ConstellationRecord, scene: Scene): AppState => {
  const sessions = [
    leadSession,
    previousLead,
    ...(scene === "startup" ? workerSessions.map(withStartupSetups) : workerSessions),
    ...setupSessions,
  ];

  const lead = (LEADS.get(scene) ?? leadModel)();
  const open: ReadonlyArray<SessionModel> = [lead, b1Model(), b8Model()];

  return {
    ...initialState,
    hosts: [
      host(LOCAL, "Mac Studio", STUDIO, "connected"),
      host("devbox", "devbox", DEVBOX, "reconnecting"),
    ],
    hostModels: {
      [LOCAL]: {
        ...modelFromSnapshot({
          sequence: Sequence.make(90),
          workspaces: [workspace],
          worktrees: [worktree],
          sessions: sessions.map((session) => ({
            session,
            pendingApprovals: [],
            lastTurnPreview: null,
            subagents: [],
          })),
        }),
        synchronized: true,
      },
    },
    sessions: Object.fromEntries(
      open.flatMap((m) => (m.session === null ? [] : [[sessionKey(LOCAL, m.session.id), m]]))
    ),
    constellations: {
      [LOCAL]: {
        listed: new Map([[record.constellation.id, constellationSummaryOf(record.constellation)]]),
        byId: new Map([[record.constellation.id, record]]),
      },
    },
  };
};

const bridge: PolarisApi = {
  request: (method) =>
    // SAFETY: only constellation.stats is answered, with its own output type.
    Promise.resolve(
      (method === "constellation.stats"
        ? { ok: true, value: statsFixture(37) }
        : { ok: false, error: { code: "Unsupported", message: "preview" } }) as never
    ),
  subscribe: () => () => undefined,
  onAppEvent: () => () => undefined,
};

const setPreviewSignals = (scene: Scene) => {
  setSignals({
    workers: new Map<string, Partial<WorkerFacts>>([
      [
        "att-B2-1",
        {
          subagents: [
            {
              id: "sa-b2",
              title: "Read the MCP SDK's transport docs",
              agent: "Explore",
              since: ago(3),
            },
          ],
        },
      ],
      ["att-B3-1", { activity: { kind: "lease", resource: "bench", holder: "B2", since: ago(2) } }],
      [
        "att-C4-1",
        { activity: { kind: "command", text: "bun test apps/daemon/src/mcp", since: ago(1) } },
      ],
      // Later entries win: the failures scene's B2 has no Turn in flight.
      ...(scene === "failures" ? FAILURE_SIGNALS : []),
      ...(scene === "startup" ? STARTUP_SIGNALS : []),
    ]),
    receipts: new Map([
      ["i-spec", { command: "bun run spec", exitCode: 0 }],
      ["i-tests", { command: "bun test …/verification", exitCode: 0 }],
      ["i-trace", { command: "trace validation · handover.ndjson", exitCode: 1 }],
      ["i-g1-test", { command: "bun run test", exitCode: 0 }],
      ["i-g1-spec", { command: "bun run spec", exitCode: 0 }],
    ]),
    leadContext: new Map(),
  });
};

const sceneOf = (hash: string): Scene => {
  const name = hash.replace(/^#constellation\//, "");

  return SCENES.find((s) => s === name) ?? "lead";
};

/** Mounts the real shell with the Lead selected and the scene's tab state. */
export const mountConstellationPreview = (root: HTMLElement, hash: string) => {
  const scene = sceneOf(hash);
  const store = createStore<AppState>(() => stateFor(recordFor(scene), scene));

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: (density) => store.setState({ density }),
    setAppearance: ({ density, theme }) => store.setState({ density, theme }),
  };

  const navigation = createNavigation({ app: store, storage: null });

  standInBridge(bridge);
  installConstellationClient(fakeClient(store, { unmerged: scene === "handed-unmerged" }));
  setPreviewSignals(scene);
  patchLeadUi(leadKey(LOCAL, LEAD), () => UI[scene]);
  navigation.actions.selectSession({ hostKey: LOCAL, sessionId: LEAD });
  showOutput({ hostKey: LOCAL, workspaceId: WORKSPACE }, LEAD);

  const commands = createCommandRegistry({ platform: "mac" });

  createRoot(root).render(<App value={{ connection, navigation, commands }} />);

  return connection.setDensity;
};
