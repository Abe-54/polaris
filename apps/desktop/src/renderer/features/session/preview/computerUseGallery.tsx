/**
 * `#computer-use/live`: the transcript's computer use Tool Runs and the live view in its four
 * states (Paper CU5), on fixtures: frames are drawn here, no Host captures anything.
 */
import {
  AppId,
  Capability,
  ComputerUseCall,
  ComputerUseItem,
  ControlledApp,
  HostId,
  Sequence,
  SessionId,
  TurnItem,
} from "@polaris/protocol";
import { Kicker } from "@polaris/ui";
import type { ReactNode } from "react";
import { createStore } from "zustand/vanilla";
import type { HostView, PolarisApi } from "../../../../shared/api.ts";
import { PreviewFeedItem, type PreviewImage } from "../../../../shared/computerUseContract.ts";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { modelFromSnapshot } from "../../../store/hostModel.ts";
import type { SessionModel } from "../../../store/sessionModel.ts";
import { type AppState, type Connection, initialState, sessionKey } from "../../../store/store.ts";
import { standInBridge } from "../../bridge.ts";
import { completedItemView } from "../model/items.ts";
import { groupItems } from "../model/runs.ts";
import { DesktopRunRow } from "../ui/computerUse/DesktopRunRow.tsx";
import { LiveView } from "../ui/computerUse/LiveView.tsx";
import { SessionTargetContext } from "../ui/polarisTool/target.ts";
import { model, session, turn, view, workspace, worktree } from "./fixtures.ts";

const SIMULATOR = { id: AppId.make("com.apple.iphonesimulator"), name: "Simulator" };

const NOTES = { id: AppId.make("com.apple.Notes"), name: "Notes" };

const FIREFOX = { id: AppId.make("/usr/share/applications/firefox.desktop"), name: "Firefox" };

const hostView = (key: string, label: string, platform: string): HostView => ({
  key,
  label,
  colour: null,
  alias: null,
  kind: key === "studio" ? "local" : "ssh",
  proofHarness: false,
  status: {
    state: "connected",
    failure: null,
    attempt: 0,
    since: 0,
    nextAttemptAt: null,
    host: {
      hostId: HostId.make(`h-${key}`),
      hostname: key,
      platform,
      daemonVersion: "0.0.0",
      homeDir: "/Users/lucas",
      startedAt: "2026-11-10T00:00:00.000Z",
    },
    capabilities: platform.startsWith("darwin")
      ? Capability.literals
      : Capability.literals.filter((c) => c !== "computer-use.preview"),
    epoch: 1,
    latencyMs: null,
    lastSeenAt: null,
  },
});

let n = 0;

const call = (
  tool: string,
  app: { id: AppId; name: string } | null,
  input: Readonly<Record<string, string>>,
  status: "completed" | "running" | "failed" = "completed",
  output: string | null = null
) =>
  TurnItem.cases.ToolCall.make({
    id: `cu-${(n += 1)}`,
    name: `mcp__polaris_desktop__${tool}`,
    kind: "mcp",
    mcp: { server: "polaris_desktop", tool },
    computerUse: app === null ? null : ComputerUseCall.make({ app, window: null, headed: false }),
    input,
    output,
    status,
  });

const say = (text: string) => TurnItem.cases.AssistantMessage.make({ id: `m-${(n += 1)}`, text });

const sessionModel = (
  id: string,
  title: string,
  harness: string,
  items: ReadonlyArray<TurnItem>
): SessionModel => {
  const s = session(id, { title, harness });

  return model({ session: s, turns: [view(turn(s.id, 24, "Book two guests", "working"), items)] });
};

const TRANSCRIPT = [
  say(
    "The booking flow passes its tests. I'll open Trips in Simulator and book two guests by hand."
  ),
  call("snapshot", SIMULATOR, { app: "Simulator" }),
  call("find", SIMULATOR, { name: "Search", app: "Simulator" }),
  call("type", SIMULATOR, { ref: "@e3", text: "Lisbon" }),
  call("press", SIMULATOR, { combo: "return", app: "Simulator" }),
  say("Search works. Now the booking sheet."),
  call("snapshot", SIMULATOR, { app: "Simulator" }),
  call("click", null, { ref: "@e9" }, "running"),
];

const SESSIONS = {
  transcript: sessionModel("s-live", "Polaris planning", "claude", TRANSCRIPT),
  still: sessionModel("s-still", "Booking flow on Linux", "claude", [
    call("click", FIREFOX, { ref: "@e2" }),
  ]),
  inUse: sessionModel("s-in-use", "Trips smoke test", "codex", [
    call("click", SIMULATOR, { ref: "@e2" }, "failed", "Simulator is in use by another session."),
  ]),
  holder: sessionModel("s-holder", "Spike GPUI review", "claude", []),
  locked: sessionModel("s-locked", "Release notes pass", "claude", [
    call("click", SIMULATOR, { ref: "@e2" }, "failed", "The screen on MacBook Pro is locked."),
  ]),
  notes: sessionModel("s-notes", "Glossary pass", "claude", [
    call("type", NOTES, { ref: "@e4", text: "Constellation" }, "running"),
  ]),
};

const HOSTS = [
  hostView("studio", "Mac Studio", "darwin-arm64"),
  hostView("linux-vm", "Linux VM", "linux-x64"),
  hostView("macbook", "MacBook Pro", "darwin-arm64"),
];

/** Each session's Host. */
const HOST_OF = new Map([
  ["s-still", "linux-vm"],
  ["s-locked", "macbook"],
]);

const hostOf = (sessionId: string) => HOST_OF.get(sessionId) ?? "studio";

const stateOf = (): AppState => {
  const models = Object.values(SESSIONS);

  return {
    ...initialState,
    hosts: HOSTS,
    hostModels: Object.fromEntries(
      HOSTS.map((h) => [
        h.key,
        {
          ...modelFromSnapshot({
            sequence: Sequence.make(1),
            workspaces: [workspace],
            worktrees: [worktree],
            sessions: models.flatMap((m) =>
              m.session === null || hostOf(m.session.id) !== h.key
                ? []
                : [
                    {
                      session: m.session,
                      pendingApprovals: [],
                      lastTurnPreview: null,
                      subagents: [],
                    },
                  ]
            ),
          }),
          synchronized: true,
        },
      ])
    ),
    sessions: Object.fromEntries(
      models.flatMap((m) =>
        m.session === null ? [] : [[sessionKey(hostOf(m.session.id), m.session.id), m]]
      )
    ),
  };
};

interface Sketch {
  readonly size: readonly [number, number];
  readonly frame: string;
  readonly page: string;
  readonly title: string;
  readonly band: string;
  readonly bandHeight: number;
}

/** The windows the agents work in: a phone's booking sheet, a browser page, a note. */
const SKETCHES = {
  phone: {
    size: [300, 600],
    frame: "#0a0b0d",
    page: "#f2efe8",
    title: "Lisbon",
    band: "#c9d3cf",
    bandHeight: 140,
  },
  browser: {
    size: [560, 300],
    frame: "#0a0b0d",
    page: "#f4f4f6",
    title: "Trips",
    band: "#3d6ad6",
    bandHeight: 40,
  },
  notes: {
    size: [560, 300],
    frame: "#2b2822",
    page: "#2b2822",
    title: "Glossary",
    band: "#c9d3cf",
    bandHeight: 40,
  },
} as const satisfies Record<string, Sketch>;

const sketch = (g: OffscreenCanvasRenderingContext2D, k: Sketch) => {
  const [w, h] = k.size;

  g.fillStyle = k.frame;
  g.fillRect(0, 0, w, h);
  g.fillStyle = k.page;
  g.fillRect(10, 10, w - 20, h - 20);
  g.fillStyle = "#1c1c1c";
  g.font = "36px Georgia";
  g.fillText(k.title, 34, 80);
  g.fillStyle = k.band;
  g.fillRect(34, 110, w - 68, k.bandHeight);
  g.fillStyle = "#1c1c1c";
  g.fillRect(34, h - 80, w - 68, 46);
};

const drawWindow = async (kind: keyof typeof SKETCHES): Promise<PreviewImage> => {
  const k = SKETCHES[kind];
  const canvas = new OffscreenCanvas(k.size[0], k.size[1]);
  const g = canvas.getContext("2d");

  if (g !== null) sketch(g, k);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });

  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    width: k.size[0],
    height: k.size[1],
    capturedAt: new Date(Date.now() - 3000).toISOString(),
    window: { id: "4242", title: kind === "phone" ? "iPhone 17 Pro" : "Trips" },
  };
};

const PICTURES = new Map<string, keyof typeof SKETCHES>([
  ["s-still", "browser"],
  ["s-notes", "notes"],
]);

const pictureOf = (sessionId: string) => drawWindow(PICTURES.get(sessionId) ?? "phone");

type Listener = { readonly items: (items: never) => void };

const later = (deliver: () => Promise<ReadonlyArray<unknown>>, listener: Listener) =>
  // SAFETY: each fixture feed's items match its kind's SubscriptionItems.
  void deliver().then((items) => listener.items(items as never));

/** The studio's Simulator, held by another session: the in-use state's holder. */
const controlled = async () => [
  ComputerUseItem.cases.ControlledApps.make({
    apps: [
      new ControlledApp({
        app: SIMULATOR,
        sessionId: SessionId.make("s-holder"),
        since: "2026-11-10T09:00:00.000Z",
      }),
    ],
  }),
];

/** Linux has no live capture; the locked Mac sends a frame, then says the screen locked. */
const frames = (id: string) => async () => {
  if (hostOf(id) === "linux-vm") return [PreviewFeedItem.NoLive()];
  const frame = PreviewFeedItem.Frame({ image: await pictureOf(id) });

  return id === "s-locked" ? [frame, PreviewFeedItem.Idle({ reason: "screen-locked" })] : [frame];
};

const bridge: PolarisApi = {
  // SAFETY: the only request the gallery answers is `computerUse.preview.latest`.
  request: (async (method: string, input: { readonly sessionId?: string }) =>
    method === "computerUse.preview.latest" && input.sessionId !== undefined
      ? { ok: true, value: await pictureOf(input.sessionId) }
      : { ok: false, error: { code: "Unsupported", message: "gallery" } }) as never,
  subscribe: (kind, input, listener: Listener) => {
    if (kind === "computerUse.watch" && "hostKey" in input && input.hostKey === "studio")
      later(controlled, listener);

    if (kind === "computerUse.preview.watch" && "sessionId" in input)
      later(frames(input.sessionId), listener);

    return () => undefined;
  },
  onAppEvent: () => () => undefined,
};

const runOf = (m: SessionModel) =>
  groupItems((m.turns.at(-1)?.items ?? []).map(completedItemView)).flatMap((e) =>
    e.kind === "desktop" ? [e.run] : []
  );

const Labelled = ({
  kicker,
  children,
}: {
  readonly kicker: string;
  readonly children: ReactNode;
}) => (
  <div className="flex min-w-0 flex-col gap-2">
    <Kicker className="font-normal tracking-[0.06em]">{kicker}</Kicker>
    {children}
  </div>
);

const Card = ({
  children,
  width = 352,
}: {
  readonly children: ReactNode;
  readonly width?: number;
}) => (
  <div
    data-surface="raised"
    className="bg-raised rounded-card border-hairline border"
    style={{ width }}
  >
    {children}
  </div>
);

const Transcript = () => {
  const m = SESSIONS.transcript;
  const target = { hostKey: "studio", sessionId: m.session?.id ?? SessionId.make("s-live") };
  const entries = groupItems((m.turns.at(-1)?.items ?? []).map(completedItemView));

  return (
    <SessionTargetContext.Provider value={target}>
      <div className="rounded-card border-hairline flex w-[460px] flex-col gap-2 border p-5">
        {entries.map((entry) =>
          entry.kind === "desktop" ? (
            <DesktopRunRow
              key={entry.id}
              id={entry.id}
              run={entry.run}
              items={entry.items}
              renderItem={() => null}
            />
          ) : entry.kind === "item" && entry.item.kind === "message" ? (
            <p key={entry.item.id} className="text-body text-text-default">
              {entry.item.text}
            </p>
          ) : null
        )}
      </div>
    </SessionTargetContext.Provider>
  );
};

const State = ({
  kicker,
  model: m,
  peek,
}: {
  readonly kicker: string;
  readonly model: SessionModel;
  readonly peek?: string;
}) => {
  const run = runOf(m).at(-1);

  if (run === undefined || m.session === null) return null;

  return (
    <Labelled kicker={kicker}>
      <Card width={peek === undefined ? 352 : 300}>
        <LiveView
          hostKey={hostOf(m.session.id)}
          sessionId={m.session.id}
          run={run}
          {...(peek === undefined ? {} : { title: m.session.title, liveFooter: peek })}
        />
      </Card>
    </Labelled>
  );
};

const Gallery = () => (
  <div className="flex flex-col gap-10 p-10" data-testid="computer-use-preview">
    <Labelled kicker="CU5 · Tool Run lines · hover the live run's thumbnail">
      <Transcript />
    </Labelled>
    <div className="flex flex-wrap items-start gap-8">
      <State kicker="Live" model={SESSIONS.notes} />
      <State kicker="Last frame (Linux)" model={SESSIONS.still} />
      <State kicker="In use by another session" model={SESSIONS.inUse} />
      <State kicker="Screen locked" model={SESSIONS.locked} />
      <State
        kicker="Sidebar peek"
        model={SESSIONS.transcript}
        peek="Simulator · clicking · turn 24"
      />
    </div>
  </div>
);

/** The gallery, in the shell's context so the live view reads Hosts and sessions as it does in the app. */
export const LiveViewGallery = () => {
  const store = createStore<AppState>(() => stateOf());

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: (density) => store.setState({ density }),
    setAppearance: ({ density, theme }) => store.setState({ density, theme }),
  };

  standInBridge(bridge);

  return (
    <AppProvider
      value={{
        connection,
        navigation: createNavigation({ app: store, storage: null }),
        commands: createCommandRegistry({ platform: "mac" }),
      }}
    >
      <Gallery />
    </AppProvider>
  );
};
