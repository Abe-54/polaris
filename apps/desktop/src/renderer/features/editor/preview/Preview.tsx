/**
 * The editor on fixtures, for screenshots against Paper E1–E3 and the editor
 * budgets: `#editor/<scene>` renders the pane, a stand-in explorer column and
 * the status row on in-memory files (`?terminal` opens a stand-in terminal). Scenes: e1, e3, close, conflict, compare, reload,
 * vim, find, tabs20, readonly, binary, empty, big (`?persist` keeps drafts in localStorage). Its own chunk.
 * Worst cases (ENG-499): tabs40, worst (40 tabs, vim, a selection); `?git=worst` a 121-character
 * branch, `?host=remote|reconnecting|offline` a far Host.
 */
import { openSearchPanel } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import { Horizon, Toaster, TooltipProvider } from "@polaris/ui";
import { useEffect, useRef, useState } from "react";
import { EditorColumn, TerminalChip, useTerminalLeaving } from "../../terminal/index.ts";
import { createRoot } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import type { Density, PolarisApi } from "../../../../shared/api.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { installKeyboard } from "../../../routes/keyboard.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { type AppState, type Connection, initialState } from "../../../store/store.ts";
import { standInBridge } from "../../bridge.ts";
import { settingsStore } from "../../settings/index.ts";
import { createFakeFiles, type FakeFiles } from "../files/fake.ts";
import { memoryKeyValue } from "../model/drafts.ts";
import { memorySpill } from "../model/draftStore.ts";
import { indexedDbSpill } from "../runtime/idbSpill.ts";
import {
  closeTab,
  openFile,
  renameFile,
  setAgentEdits,
  setAgentFiles,
} from "../runtime/actions.ts";
import { SessionId } from "@polaris/protocol";
import { ensureEditor } from "../runtime/app.ts";
import { getActiveEditor } from "../runtime/hooks.ts";
import { EditorPane } from "../ui/EditorPane.tsx";
import { EditorStatus } from "../ui/EditorStatus.tsx";
import { StatusBar } from "../explorer/ui/StatusBar.tsx";
import type { GitFacts } from "../explorer/data/store.ts";
import { FILES, HOST, path, ROOT, WORKSPACE } from "./fixtures.ts";
import { statusHost, WORST_GIT, WORST_TABS, worstFiles } from "./worst.ts";

const bridge: PolarisApi = {
  request: () => Promise.resolve({ ok: false, error: { code: "Unsupported", message: "preview" } }),
  subscribe: () => () => undefined,
  onAppEvent: () => () => undefined,
};

const RECONNECT = path("daemon/src/hosts/reconnect.ts");

const SESSION_ROW = path("desktop/src/orchestrator/session-row.tsx");

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** The active editor once its file has loaded. */
const activeView = async (): Promise<EditorView> => {
  for (;;) {
    const view = getActiveEditor()?.view;

    if (view !== undefined) return view;
    await nextFrame();
  }
};

const E1_TABS = [RECONNECT, path("daemon/src/hosts/transport.ts"), SESSION_ROW, path("CONTEXT.md")];

const openE1 = () => {
  for (const p of E1_TABS) openFile({ hostKey: HOST, workspaceId: WORKSPACE, path: p });
  openFile({ hostKey: HOST, workspaceId: WORKSPACE, path: RECONNECT, line: 28, column: 14 });
  setAgentFiles(HOST, WORKSPACE, new Map([[SESSION_ROW, "claude"]]));
};

/** E1: an unsaved edit in reconnect.ts, as the artboard's dot says. */
const typeEdit = async () => {
  const view = await activeView();

  view.dispatch({
    changes: { from: view.state.doc.line(6).to, insert: " // ms" },
    userEvent: "input.type",
  });
};

const agentEdit = (files: FakeFiles) => {
  const before = files.text(HOST, RECONNECT) ?? "";

  files.agentWrite(
    HOST,
    RECONNECT,
    before.replace("const MAX_ATTEMPTS = 8;", "const MAX_ATTEMPTS = 12;\nconst JITTER_MS = 250;")
  );
};

const E3_EDIT = {
  sessionId: SessionId.make("ses_polaris_planning"),
  title: "Polaris planning",
  harness: "claude",
  turnId: "turn_24",
  turnNumber: 24,
  turnStartedAt: new Date(Date.now() - 72_000).toISOString(),
  lastChangeAt: new Date().toISOString(),
  live: true,
};

/** E3: the agent rewrites the needs-you span over a few writes, as Claude Code's edits land. */
const agentTypes = (files: FakeFiles) => {
  const steps = [
    (t: string) =>
      t.replace(
        'const needsYou = session.state === "needs-you";',
        'const needsYou = session.state === "needs-you";\n  const working = session.state === "working";'
      ),
    (t: string) =>
      t.replace(
        '<span className={needsYou ? "row-doing needs-you" : "row-doing"}>',
        '<span className={needsYou ? "row-doing needs-you" : working ? "row-doing working" : "row-doing"}>'
      ),
  ];

  let i = 0;

  const next = () => {
    const step = steps[i++];
    const before = files.text(HOST, SESSION_ROW);

    if (step === undefined || before === null) return;
    files.agentWrite(HOST, SESSION_ROW, step(before));
    setTimeout(next, 900);
  };

  setTimeout(next, 400);
};

const tabs20 = () => {
  for (let i = 0; i < 20; i++) {
    const file = `${ROOT}/daemon/src/generated/module-${String(i).padStart(2, "0")}.ts`;

    openFile({ hostKey: HOST, workspaceId: WORKSPACE, path: file });
  }
};

/** 40 tabs, one with unsaved edits and one an agent is writing, the first one active. */
const tabs40 = async () => {
  for (const file of WORST_TABS) openFile({ hostKey: HOST, workspaceId: WORKSPACE, path: file });
  setAgentFiles(HOST, WORKSPACE, new Map([[WORST_TABS[2] ?? "", "codex"]]));
  openFile({ hostKey: HOST, workspaceId: WORKSPACE, path: WORST_TABS[1] ?? "" });
  const view = await activeView();

  view.dispatch({ changes: { from: 0, insert: "// draft\n" }, userEvent: "input.type" });
};

type Scene = (files: FakeFiles) => Promise<void> | void;

const SCENES = new Map<string, Scene>(
  Object.entries({
    e1: async () => {
      openE1();
      await typeEdit();
    },
    e3: async (files) => {
      openFile({ hostKey: HOST, workspaceId: WORKSPACE, path: SESSION_ROW });
      openFile({
        hostKey: HOST,
        workspaceId: WORKSPACE,
        path: path("desktop/src/orchestrator/session-row.css"),
      });
      openFile({ hostKey: HOST, workspaceId: WORKSPACE, path: SESSION_ROW });
      setAgentFiles(HOST, WORKSPACE, new Map([[SESSION_ROW, "claude"]]));
      setAgentEdits(HOST, WORKSPACE, new Map([[SESSION_ROW, E3_EDIT]]));
      await activeView();
      agentTypes(files);
    },
    close: async () => {
      openE1();
      await typeEdit();
      closeTab(HOST, WORKSPACE, RECONNECT);
    },
    conflict: async (files) => {
      openE1();
      await typeEdit();
      agentEdit(files);
    },
    compare: async (files) => {
      openE1();
      await typeEdit();
      agentEdit(files);
      await nextFrame();
      document.querySelector<HTMLButtonElement>('[data-testid="editor-banner"] button')?.click();
    },
    reload: async (files) => {
      openE1();
      await activeView();
      agentEdit(files);
    },
    vim: () => openE1(),
    find: async () => {
      openE1();
      openSearchPanel(await activeView());
    },
    tabs20,
    tabs40,
    worst: async () => {
      await tabs40();
      const view = await activeView();

      view.dispatch({
        selection: { anchor: view.state.doc.line(10).from, head: view.state.doc.line(19).to },
      });
    },
    readonly: () => openFile({ hostKey: HOST, workspaceId: WORKSPACE, path: RECONNECT }),
    binary: () =>
      openFile({ hostKey: HOST, workspaceId: WORKSPACE, path: path("design/assets/logo.png") }),
    big: () => openFile({ hostKey: HOST, workspaceId: WORKSPACE, path: path("bench/big.ts") }),
    empty: () => undefined,
  } satisfies Record<string, Scene>)
);

const seed = () => {
  const generated = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [
      `${ROOT}/daemon/src/generated/module-${String(i).padStart(2, "0")}.ts`,
      (FILES[RECONNECT] ?? "").repeat(40),
    ])
  );

  return { [HOST]: { ...FILES, ...generated, ...worstFiles() }, pi: FILES };
};

/** A long branch, so a narrow window shows Completions' glyph and the middle truncation. */
const GIT: GitFacts = {
  toplevel: ROOT,
  worktree: false,
  head: "a0afe434",
  branch: "lucas/eng-499-desktop-chrome-redesign-moonlit-midnight",
  ahead: 2,
  behind: 0,
  tracking: null,
  marks: { files: new Map(), dirtyFolders: new Set(), changed: 5 },
  entries: [],
};

/** A stand-in terminal card: the preview has no Daemon to run a shell. */
const StandInTerminal = () => (
  <div className="flex h-[232px] flex-col" data-testid="terminal-drawer">
    <div className="text-label flex h-[42px] shrink-0 items-center gap-2 px-3">
      <span className="bg-fill-selected text-text-strong rounded-full px-3 py-1">bun test</span>
      <span className="text-text-subtle px-2">zsh</span>
      <span className="flex-1" />
      <span className="text-code-inline text-text-subtle font-mono">~/code/polaris</span>
    </div>
    <pre className="text-code text-text-default px-4 font-mono">
      {
        "~/code/polaris main ❯ bun test src/orchestrator\nbun test v1.3.9\n✓ SessionRow > shows the title"
      }
    </pre>
  </div>
);

/** X-I's Variant C: the stand-in explorer on the ground, the editor and terminal as panels. */
const Frame = ({ terminal, hash }: { readonly terminal: boolean; readonly hash: string }) => {
  const [shown, setShown] = useState(terminal);
  const leaving = useTerminalLeaving(shown);
  const dock = useRef<HTMLDivElement>(null);

  // The screenshot script toggles the terminal as fast as ⌃` would, mid-morph.
  useEffect(() => {
    Object.assign(window, { __polarisTerminal: () => setShown((s) => !s) });
  }, []);

  return (
    <div className="bg-ground text-text-default flex h-full flex-col">
      <div className="flex min-h-0 flex-1 gap-1.5 pt-1.5 pr-1.5 pb-1.5">
        <div className="relative isolate flex w-[270px] shrink-0 flex-col px-4 py-3">
          <p className="text-heading text-text-strong">polaris</p>
          <p className="text-caption text-text-subtle">Mac Studio · ~/code/polaris</p>
          <Horizon />
        </div>
        <EditorColumn
          dock={dock}
          hostKey={HOST}
          workspaceId={WORKSPACE}
          leaving={leaving}
          terminal={shown || leaving ? <StandInTerminal /> : null}
          chip={<TerminalChip onToggle={() => setShown(true)} count={1} />}
          status={
            <StatusBar
              host={statusHost(hash)}
              place={{ key: "preview", hostKey: HOST, workspaceId: WORKSPACE, root: ROOT }}
              git={hash.includes("git=worst") ? WORST_GIT : GIT}
              right={<EditorStatus hostKey={HOST} workspaceId={WORKSPACE} />}
            />
          }
        >
          <EditorPane hostKey={HOST} workspaceId={WORKSPACE} root={ROOT} />
        </EditorColumn>
      </div>
    </div>
  );
};

export const mountEditorPreview = (root: HTMLElement, hash: string) => {
  const scene = hash.replace(/^#editor\//, "").split("?")[0] ?? "e1";
  const store = createStore<AppState>(() => ({ ...initialState }));

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: (density: Density) => store.setState({ density }),
    setAppearance: ({ density, theme }) => store.setState({ density, theme }),
  };

  const navigation = createNavigation({ app: store, storage: null });
  const commands = createCommandRegistry({ platform: "mac" });
  const files = createFakeFiles(seed(), { readOnlyHosts: ["pi"] });

  standInBridge(bridge);
  installKeyboard({ actions: navigation.actions, registry: commands });

  if (scene === "vim" || scene === "worst") {
    settingsStore.setState((s) => ({ sessions: { ...s.sessions, editorVim: true } }));
  }

  ensureEditor({
    app: () => store.getState(),
    files,
    // `?persist`: drafts and tabs in localStorage, as the app keeps them, for the restart check.
    kv: hash.includes("?persist") ? globalThis.localStorage : memoryKeyValue(),
    spill: hash.includes("?persist") ? indexedDbSpill() : memorySpill(),
    canWrite: () => scene !== "readonly",
  });

  createRoot(root).render(
    <AppProvider value={{ connection, navigation, commands }}>
      <TooltipProvider>
        <Frame terminal={hash.includes("terminal")} hash={hash} />
        <Toaster />
      </TooltipProvider>
    </AppProvider>
  );

  void SCENES.get(scene)?.(files);
  Object.assign(window, {
    __polarisEditor: {
      files,
      openFile,
      closeTab,
      renameFile,
      activeView: () => getActiveEditor()?.view ?? null,
    },
  });

  return connection.setDensity;
};
