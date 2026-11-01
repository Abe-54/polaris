import { profileAttach } from "./profileAttachScene.ts";
/**
 * The session view on fixtures, for screenshots against Paper
 * (`scripts/sessionScreens.ts`): `#preview/<scene>` renders the shell with one
 * scene selected, on a stand-in bridge and store, no Daemon involved. Its own chunk.
 */
import {
  Capability,
  HARNESS_CATALOGUE,
  type HarnessStatus,
  HostId,
  PlanLimit,
  Sequence,
  UsageStreamItem,
  Workspace,
  Worktree,
  type SessionId,
} from "@polaris/protocol";
import { createRoot } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import { setClientPlatform } from "../../../../shared/platform.ts";
import type {
  HostView,
  PolarisApi,
  RequestInput,
  RequestMethod,
  Result,
  SubscriptionKind,
} from "../../../../shared/api.ts";
import { modelFromSnapshot } from "../../../store/hostModel.ts";
import type { SessionModel } from "../../../store/sessionModel.ts";
import { App } from "../../../app/App.tsx";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { type AppState, type Connection, initialState, sessionKey } from "../../../store/store.ts";
import { standInBridge } from "../../bridge.ts";
import { patchSessionUi, uiKey } from "../state.ts";
import { COMMANDS, FAST_COMMAND } from "./commands.ts";
import {
  approval,
  attachments,
  failed,
  interrupted,
  long,
  markdown,
  planning,
  question,
  steer,
  order,
  steerOutbox,
  subagents,
  workspace,
  workspaceId,
  worktree,
} from "./fixtures.ts";
import { items as itemsScene } from "./itemsScene.ts";
import { tools as toolsScene } from "./toolsScene.ts";
import { polarisTools, PREVIEW_NOTICE } from "./polarisScene.ts";
import { secret } from "./secretScene.ts";
import { setDataOutputShown } from "../../data/output/index.ts";
import { setTracesOutputShown } from "../../traces/output/index.ts";
import { findTrace, fixtureSnapshot } from "../../traces/preview/fixtureApi.ts";
import { tracesOutput } from "./tracesOutputScene.ts";
import { showOutput } from "../output/actions.ts";
import { dataApproval } from "./dataApprovalScene.ts";
import { dataWrite, dataWriteFeed, dataWriteSchemaDiff, dataWriteWorst } from "./dataWriteScene.ts";
import { visualizations, visualizations30 } from "./visualizationScene.ts";
import { background, waitingSidebar } from "./background.ts";
import { MODELS, PATCH } from "./fixtureData.ts";
import { recordBanner } from "../banners.ts";
import { WORST_SCENES, worstState } from "./worstScene.ts";
import {
  WORST_CONVERSATION_SCENES,
  type WorstConversationScene,
  worstConversationState,
  worstModels,
  worstOutbox,
} from "./worstConversation.ts";

const HOST = "local";

const host: HostView = {
  key: HOST,
  label: "Mac Studio",
  colour: null,
  alias: null,
  kind: "local",
  proofHarness: false,
  status: {
    state: "connected",
    failure: null,
    attempt: 0,
    since: 0,
    nextAttemptAt: null,
    host: {
      hostId: HostId.make("h-studio"),
      hostname: "studio",
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
};

/** "This PC": the native Windows Daemon, just upgraded (ENG-302). No language tools yet. */
const windowsHost = (): HostView => ({
  ...host,
  label: "This PC",
  status: {
    ...host.status,
    host: {
      hostId: HostId.make("h-desktop"),
      startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      hostname: "lucas-desktop",
      platform: "windows-x64",
      daemonVersion: "0.2.1",
      homeDir: "C:\\Users\\lucas",
      previousStop: {
        reason: "upgrade",
        fromVersion: "0.2.0",
        at: new Date(Date.now() - 3 * 60_000).toISOString(),
      },
    },
    capabilities: Capability.literals.filter((c) => !c.startsWith("languages")),
  },
});

const WINDOWS_REPO = "C:\\Users\\lucas\\code\\polaris";

const windowsWorkspace = new Workspace({
  id: workspace.id,
  path: WINDOWS_REPO,
  name: workspace.name,
  isGitRepo: true,
  worktreeRoot: `${WINDOWS_REPO}.worktrees`,
  hidden: false,
  registeredAt: workspace.registeredAt,
});

const windowsWorktree = new Worktree({
  id: worktree.id,
  workspaceId: worktree.workspaceId,
  path: WINDOWS_REPO,
  branch: worktree.branch,
  head: worktree.head,
  createdBySessionId: null,
  isMain: true,
});

const SCENES = {
  session: planning,
  items: itemsScene,
  tools: toolsScene,
  approval,
  question,
  secret,
  "data-approval": dataApproval,
  "profile-attach": profileAttach,
  "data-write": dataWrite,
  "data-write-worst": dataWriteWorst,
  interrupted,
  failed,
  long,
  markdown,
  steer,
  attachments,
  subagents,
  background,
  order,
  polaris: polarisTools,
  visualizations,
  "visualizations-30": visualizations30,
  "traces-output": tracesOutput,
} as const;

const SCENE_NAMES = [
  "session",
  "items",
  "tools",
  "approval",
  "question",
  "secret",
  "data-approval",
  "profile-attach",
  "data-write",
  "data-write-worst",
  "interrupted",
  "failed",
  "long",
  "markdown",
  "steer",
  "attachments",
  "subagents",
  "background",
  "order",
  "polaris",
  "visualizations",
  "visualizations-30",
  "traces-output",
  "new",
  "setup",
  "none-ready",
  "usage-2",
  "usage-3",
  "no-host",
  "windows",
  "data-output",
  ...WORST_SCENES,
  ...WORST_CONVERSATION_SCENES,
] as const;

type Scene = (typeof SCENE_NAMES)[number];

/** The Session context card's footer: "3.8M tokens · ~$4.12 · 91% read from cache". */
const SESSION_BUCKET = {
  hour: "2026-10-11T09:00:00.000Z",
  harness: "claude",
  model: "claude-opus-5",
  sessionId: null,
  tokens: {
    input: 230_000,
    cacheRead: 3_300_000,
    cacheWrite: 96_000,
    output: 174_000,
    reasoning: 0,
    cacheWrite1h: 0,
  },
  reportedCost: null,
  longContext: [],
};

const harnessOf = (input: RequestInput<RequestMethod>) =>
  "harness" in input && input.harness === "codex" ? "codex" : "claude";

type Probe = readonly [status: HarnessStatus, version: string | null];

/**
 * What each scene's Host has: mostly ready; on "setup" a sign-in and not-installed ones;
 * on "none-ready" nothing ready (an outdated Claude Code, below the floor).
 */
const HOSTS: Readonly<Record<"default" | "setup" | "none-ready", Readonly<Record<string, Probe>>>> =
  {
    default: {
      claude: ["ready", "2.1.283"],
      codex: ["ready", "0.157.1"],
      opencode: ["ready", "1.18.33"],
      gemini: ["outdated", "0.21.0"],
      copilot: ["not-installed", null],
    },
    setup: {
      claude: ["ready", "2.1.283"],
      codex: ["needs-sign-in", "0.157.1"],
      opencode: ["not-installed", null],
      gemini: ["outdated", "0.21.0"],
      copilot: ["not-installed", null],
    },
    "none-ready": {
      claude: ["outdated", "2.0.9"],
      codex: ["not-installed", null],
      opencode: ["needs-sign-in", "1.18.33"],
      gemini: ["not-installed", null],
      copilot: ["not-installed", null],
    },
  };

const hostFor = (scene: Scene) =>
  HOSTS[scene === "setup" || scene === "none-ready" ? scene : "default"];

const availability = (scene: Scene) => {
  const probes = hostFor(scene);

  return {
    harnesses: HARNESS_CATALOGUE.map((entry) => {
      const [status, version] = probes[entry.kind] ?? ["ready", entry.minVersion];

      return {
        harness: entry.kind,
        status,
        version,
        minVersion: entry.minVersion,
        signInKind: status === "ready" && entry.kind === "claude" ? "Claude Max" : null,
        detail: null,
        signInArgv: status === "not-installed" ? null : [...entry.setup.signInCommand],
      };
    }),
    checkedAt: "2026-09-30T00:00:00.000Z",
  };
};

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

const LIMITS = [
  new PlanLimit({
    harness: "claude",
    kind: "five-hour",
    scope: null,
    windowMinutes: 300,
    usedPercent: 42,
    status: "ok",
    resetsAt: later(130),
    observedAt: ago(1),
    plan: "max",
  }),
  new PlanLimit({
    harness: "claude",
    kind: "weekly",
    scope: null,
    windowMinutes: 10_080,
    usedPercent: 18,
    status: "ok",
    resetsAt: later(4 * 24 * 60),
    observedAt: ago(1),
    plan: "max",
  }),
];

const window_ = (
  harness: string,
  kind: string,
  scope: string | null,
  usedPercent: number,
  status: "ok" | "warning" = "ok"
) =>
  new PlanLimit({
    harness,
    kind,
    scope,
    windowMinutes: kind === "weekly" ? 10_080 : 300,
    usedPercent,
    status,
    resetsAt: later(kind === "weekly" ? 4 * 24 * 60 : 228),
    observedAt: ago(1),
    plan: harness === "claude" ? "max" : "pro",
    // The Daemon's typical 5-hour window, on Claude's whole-plan weekly.
    weeklyPerSession: harness === "claude" && kind === "weekly" && scope === null ? 14.6 : null,
  });

/**
 * Settings → Usage: Claude with two windows (Paper S2) or three (its model-scoped weekly), and
 * Codex. Forecasts: 5-hour in reserve, weekly in deficit (runs out), a near-limit run-out.
 */
const usageLimits = (scene: Scene) => [
  window_("claude", "five-hour", null, 16),
  window_("claude", "weekly", null, 62),
  ...(scene === "usage-3" ? [window_("claude", "weekly", "Fable", 92, "warning")] : []),
  window_("codex", "five-hour", null, 99.6, "warning"),
  window_("codex", "weekly", null, 0.4),
];

const isUsage = (scene: Scene) => scene === "usage-2" || scene === "usage-3";

/** The feeds the session view opens: availability and Plan Limits, sent once. */
const feed = (scene: Scene, kind: SubscriptionKind): ReadonlyArray<unknown> => {
  if (kind === "harness.availability") return [availability(scene)];

  if (kind === "usage" && isUsage(scene))
    return usageLimits(scene).map((limit) =>
      UsageStreamItem.cases.PlanLimitChanged.make({ limit })
    );

  if (kind === "data.sources.watch" || kind === "data.queryLog.watch") return dataWriteFeed(kind);

  if (kind === "traces.watch") return [fixtureSnapshot("traces")];

  return kind === "plan-limits" ? LIMITS : [];
};

const answer = (
  scene: Scene,
  method: RequestMethod,
  input: RequestInput<RequestMethod>
): Result<unknown> => {
  if (method === "harness.availability") return { ok: true, value: availability(scene) };

  if (method === "harness.models") {
    const harness = harnessOf(input);

    return {
      ok: true,
      value: {
        harness,
        models: scene.startsWith("worst-") ? worstModels(harness) : MODELS[harness],
        switchesModel: true,
        backgroundsCommands: true,
        fetchedAt: "",
      },
    };
  }

  if (method === "harness.commands") {
    return {
      ok: true,
      value: {
        harness: harnessOf(input),
        cwd: "",
        commands: harnessOf(input) === "codex" ? [...COMMANDS, FAST_COMMAND] : COMMANDS,
        fetchedAt: "",
      },
    };
  }

  if (method === "git.diff")
    return { ok: true, value: { bytes: new TextEncoder().encode(PATCH), files: 3 } };

  if (method === "dispatch") return { ok: true, value: { sequence: null } };

  if (method === "usage.query") {
    const forSession = "sessionId" in input && input.sessionId !== null;

    return {
      ok: true,
      value: {
        report: {
          buckets: forSession ? [SESSION_BUCKET] : [],
          indexedAt: null,
          indexing: false,
        },
        estimates: forSession ? [{ estimatedUsd: 4.12, unpricedTokens: 0 }] : [],
        pricesFetchedAt: null,
      },
    };
  }

  return { ok: false, error: { code: "Unsupported", message: "preview" } };
};

const images = new Map<string, Promise<Result<unknown>>>();

/** One stand-in per size, so the preview's own drawing doesn't weigh on scroll measurements. */
const fixtureImage = (path: string): Promise<Result<unknown>> => {
  const key = path.includes("a1") ? "a1" : path.includes("a2") ? "a2" : "other";
  const known = images.get(key);

  if (known !== undefined) return known;
  const made = drawImage(path);

  images.set(key, made);

  return made;
};

/** A stand-in for a staged image: a gradient with its name, at the path's stored size. */
const drawImage = async (path: string): Promise<Result<unknown>> => {
  const [w, h] = path.includes("a1") ? [1440, 900] : path.includes("a2") ? [600, 800] : [800, 600];
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext("2d");

  if (g !== null) {
    const fill = g.createLinearGradient(0, 0, w, h);

    fill.addColorStop(0, "#2a3350");
    fill.addColorStop(1, "#7b8bb8");
    g.fillStyle = fill;
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#f4f5f7";
    g.font = `${Math.round(h / 10)}px sans-serif`;
    g.fillText(path.split("/").at(-1) ?? "", w / 20, h / 2);
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());

  return {
    ok: true,
    value: { size: bytes.length, mimeType: "image/png", content: { kind: "bytes", bytes } },
  };
};

/** The data write scene's schema diff, for the Turn asked about. */
const answerData = (
  scene: Scene,
  method: RequestMethod,
  input: RequestInput<RequestMethod>
): Result<unknown> => {
  if (method === "traces.get" && "traceId" in input) return findTrace("traces", input.traceId);

  if (method !== "data.schemaDiff") return answer(scene, method, input);
  const turn = "turn" in input ? input.turn : undefined;

  return { ok: true, value: dataWriteSchemaDiff(turn) };
};

const bridgeFor = (scene: Scene): PolarisApi => ({
  // SAFETY: fixture answers match RequestOutputs for the methods the session feature calls.
  request: (method, input) =>
    // Frames load through the real main process when there is one, under its frame CSP.
    (method === "visualization.serve" && "polaris" in window
      ? window.polaris.request(method, input)
      : method === "files.read" && "path" in input && input.path.endsWith(".png")
        ? fixtureImage(input.path)
        : Promise.resolve(answerData(scene, method, input))) as never,
  subscribe: (kind, _input, listener) => {
    // SAFETY: each fixture feed's items match SubscriptionItems for its kind.
    const items = feed(scene, kind) as never;
    const deliver = () => listener.items(items);

    if (feed(scene, kind).length > 0) queueMicrotask(deliver);

    return () => undefined;
  },
  onAppEvent: () => () => undefined,
});

const stateFor = (models: ReadonlyArray<SessionModel>, windows = false): AppState => {
  return {
    ...initialState,
    hosts: [windows ? windowsHost() : host],
    hostModels: {
      [HOST]: {
        ...modelFromSnapshot({
          sequence: Sequence.make(90),
          workspaces: [windows ? windowsWorkspace : workspace],
          worktrees: [windows ? windowsWorktree : worktree],
          sessions: models.flatMap((m) =>
            m.session === null
              ? []
              : [
                  {
                    session: m.session,
                    pendingApprovals: m.pendingApprovals,
                    lastTurnPreview: m.turns.at(-1)?.turn.prompt ?? null,
                    subagents: [],
                  },
                ]
          ),
        }),
        synchronized: true,
      },
    },
    sessions: Object.fromEntries(
      models.flatMap((m) => (m.session === null ? [] : [[sessionKey(HOST, m.session.id), m]]))
    ),
  };
};

const sceneOf = (hash: string): Scene => {
  const name = hash.replace(/^#preview\//, "");

  return SCENE_NAMES.find((n) => n === name) ?? "session";
};

/** Output open on the Data tab (the Turn with the pending write) or the Traces tab. */
const showSceneOutput = (scene: Scene, sessionId: SessionId) => {
  if (scene !== "data-output" && scene !== "traces-output") return;
  showOutput({ hostKey: HOST, workspaceId }, sessionId);

  if (scene === "data-output") setDataOutputShown(uiKey(HOST, sessionId), true);
  else setTracesOutputShown(uiKey(HOST, sessionId), true);
};

/** `windows` shows the default session, on "This PC". */
const modelScene = (scene: Scene): Scene => {
  if (scene === "windows") return "session";

  return scene === "data-output" ? "data-write" : scene;
};

const previewPlatform = (scene: Scene) => {
  if (scene === "windows") setClientPlatform("win32");
};

/**
 * Mounts the real shell on fixtures, with the scene's session (or the new-session page)
 * selected. Returns the density setter, for View → Density to reach the fixture store.
 */
export const mountPreview = (root: HTMLElement, hash: string) => {
  const scene = sceneOf(hash);
  const worst = WORST_SCENES.find((name) => name === scene);

  if (worst !== undefined) return mountWorst(root, worstState(worst), "session");
  const conversation = WORST_CONVERSATION_SCENES.find((name) => name === scene);

  if (conversation !== undefined)
    return mountWorst(root, worstConversationState(conversation, host), conversation);
  // Sidebar-only sessions follow the scenes, so a scene's index still finds its model.
  const models = [...Object.values(SCENES), ...waitingSidebar].map((make) => make());

  // No Host at all, as on a Windows PC before one is added: the first-run stage.
  const noHost = scene === "no-host";

  const store = createStore<AppState>(() =>
    noHost ? { ...initialState, hostsListed: true } : stateFor(models, scene === "windows")
  );

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: (density) => store.setState({ density }),
    setAppearance: ({ density, theme }) => store.setState({ density, theme }),
  };

  const navigation = createNavigation({ app: store, storage: null });
  const isNew = scene === "new" || scene === "setup" || scene === "none-ready";
  const shown = isNew ? null : models[SCENE_NAMES.indexOf(modelScene(scene))];

  standInBridge(bridgeFor(scene));
  previewPlatform(scene);

  if (noHost) setClientPlatform("win32");
  else if (shown?.session == null) {
    navigation.actions.selectWorkspace({ hostKey: HOST, workspaceId });
    navigation.actions.startNewSession();
  } else {
    navigation.actions.selectSession({ hostKey: HOST, sessionId: shown.session.id });
  }

  if (scene === "steer" && shown?.session != null) {
    const key = uiKey(HOST, shown.session.id);
    const turnId = shown.turns.at(-1)?.turn.id ?? "";

    patchSessionUi(key, () => ({ outbox: steerOutbox(turnId) }));
  }

  // Main's record of the notify call's banner, which the preview has no main process to send.
  if (scene === "polaris" && shown?.session != null)
    recordBanner({
      hostKey: HOST,
      sessionId: shown.session.id,
      id: "n1",
      ...PREVIEW_NOTICE,
      banner: "shown",
    });

  // These open every Turn; the long one so scrolling crosses thousands of rows.
  if (
    (scene === "attachments" ||
      scene === "background" ||
      scene === "polaris" ||
      scene === "long") &&
    shown?.session != null
  ) {
    const folds = { chosen: new Map(), openFrom: shown.turns[0]?.turn.id ?? null };

    patchSessionUi(uiKey(HOST, shown.session.id), () => ({ folds }));
  }

  if (shown?.session != null) showSceneOutput(scene, shown.session.id);

  if (isUsage(scene)) navigation.actions.openSettings("usage");

  const commands = createCommandRegistry({ platform: "mac" });

  createRoot(root).render(<App value={{ connection, navigation, commands }} />);

  return connection.setDensity;
};

/** The break-UI scenes (worstScene.ts): the selected Workspace's first session, or its page. */
const mountWorst = (
  root: HTMLElement,
  { state, hostKey, shown }: ReturnType<typeof worstState>,
  scene: "session" | WorstConversationScene
) => {
  // Navigation follows the Host feed, so the bar's mode is decided once the state arrives.
  const store = createStore<AppState>(() => initialState);

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: (density) => store.setState({ density }),
    setAppearance: ({ density, theme }) => store.setState({ density, theme }),
  };

  const navigation = createNavigation({ app: store, storage: null });

  standInBridge(bridgeFor(scene));
  store.setState(state);

  if (scene === "worst-turns" && shown !== null)
    patchSessionUi(uiKey(hostKey, shown), () => ({ outbox: worstOutbox() }));

  if (shown === null) {
    navigation.actions.selectWorkspace({ hostKey, workspaceId });
    navigation.actions.startNewSession();
  } else navigation.actions.selectSession({ hostKey, sessionId: shown });

  const commands = createCommandRegistry({ platform: "mac" });

  createRoot(root).render(<App value={{ connection, navigation, commands }} />);

  return connection.setDensity;
};
