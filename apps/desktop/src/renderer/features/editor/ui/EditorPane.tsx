/**
 * The editor pane right of the explorer (DESIGN.md, Editor; Paper E1–E3):
 * tabs, breadcrumbs, the strip that needs a decision, and the code. ⌘S saves,
 * ⌃⇥ cycles tabs; the pane starts the Editor on first mount.
 */
import { EmptyState, PixelFolderIcon } from "@polaris/ui";
import { useEffect, useMemo, useState } from "react";
import { useCommands, useConnection, useShellActions } from "../../../shell/hooks.ts";
import { bannerFor, type BannerAction } from "../model/banner.ts";
import { fileKey, workspaceKey } from "../model/drafts.ts";
import { viewOf } from "../runtime/buffers.ts";
import {
  activateTab,
  closeActiveTab,
  openMarkdownPreview,
  closeOtherTabs,
  closeTab,
  cycleTabs,
  keepMyEdits,
  loadTab,
  pinFile,
  saveFile,
  setWorkspaceRoot,
  takeDiskVersion,
} from "../runtime/actions.ts";
import { languageFor } from "../model/language.ts";
import { MarkdownBuffer, PreviewControls, useMarkdownDocument } from "./MarkdownHost.tsx";
import { ensureEditor } from "../runtime/app.ts";
import { type TabView, useBuffer, useEditorTabs } from "../runtime/hooks.ts";
import { type BufferView, useEditor } from "../runtime/store.ts";
import { AgentStrip } from "./AgentStrip.tsx";
import { Banner } from "./Banner.tsx";
import { Breadcrumbs } from "./Breadcrumbs.tsx";
import { RefactorPreview } from "./RefactorPreview.tsx";
import { RefactorRecovery } from "./RefactorRecovery.tsx";
import { CloseDialog } from "./CloseDialog.tsx";
import { CodeHost } from "./CodeHost.tsx";
import { Compare } from "./Compare.tsx";
import { FileNotice } from "./FileNotice.tsx";
import { tabEntries } from "./tabMenu.ts";
import { Tabs } from "./Tabs.tsx";
import { EditorMenu } from "../menu/EditorMenu.tsx";
import { LanguagePanel } from "./LanguagePanel.tsx";
import { RenameField } from "../navigation/RenameField.tsx";
import { SymbolSearch } from "../navigation/SymbolSearch.tsx";
import { useLanguageNavigationCommands } from "../navigation/contribute.ts";
import { usePredictionCommands } from "../prediction/commands.ts";
import { EditorTrust } from "../trust/TrustCard.tsx";
import {
  activateLogTab,
  closeLogTab,
  isLogTab,
  type LogTab,
  useLogTabs,
} from "../status/logTabs.ts";
import { LogTabBody, useLogTabViews } from "../status/LogTab.tsx";
import { useLanguageCommands } from "../commands/useLanguageCommands.ts";
import {
  activateDiffTab,
  closeDiffTab,
  type DiffTab,
  DiffTabBody,
  diffTabViews,
  isDiffTab,
  pinDiffTab,
  useDiffTabs,
  useOpenChanges,
} from "../diff/index.ts";
import { commandShortcut } from "../../../../shared/keymap.ts";
import { PANE_CLASS } from "./paneLayout.ts";

export interface EditorPaneProps {
  readonly hostKey: string;
  readonly workspaceId: string;
  /** The folder the explorer is rooted at: the Workspace, or one of its Worktrees or checkouts. */
  readonly root: string;
}

/** A tab's actions by its kind: a log, a diff, or a file. */
const tabActions = (hostKey: string, workspaceId: string) => ({
  select: (id: string) => {
    if (isLogTab(id)) return activateLogTab(hostKey, workspaceId, id);

    if (isDiffTab(id)) return activateDiffTab(hostKey, workspaceId, id);
    activateDiffTab(hostKey, workspaceId, null);
    activateLogTab(hostKey, workspaceId, null);
    activateTab(hostKey, workspaceId, id);
  },
  close: (id: string) => {
    if (isLogTab(id)) closeLogTab(hostKey, workspaceId, id);
    else if (isDiffTab(id)) closeDiffTab(hostKey, workspaceId, id);
    else closeTab(hostKey, workspaceId, id);
  },
  pin: (id: string) =>
    isDiffTab(id) ? pinDiffTab(hostKey, workspaceId, id) : pinFile(hostKey, workspaceId, id),
});

const useEditorCommands = (
  hostKey: string,
  workspaceId: string,
  active: string | null,
  current: string | null,
  extraTabs: ReadonlyArray<{ readonly id: string }>
) => {
  const commands = useCommands();

  useEffect(() => {
    return commands.register({
      "editor.markdownPreview": {
        run: () => openMarkdownPreview(hostKey, workspaceId),
        enabled: () => active !== null && languageFor(active) === "markdown",
      },
      "editor.save": {
        run: () => void (active === null ? null : saveFile(hostKey, active)),
        enabled: () => active !== null,
      },
      "tab.close": {
        run: () => {
          if (current === null) window.close();
          else tabActions(hostKey, workspaceId).close(current);
        },
      },
      "tab.closeOthers": {
        run: () => {
          closeOtherTabs(hostKey, workspaceId, current);

          for (const { id } of extraTabs)
            if (id !== current) tabActions(hostKey, workspaceId).close(id);
        },
        enabled: () => current !== null,
      },
      "editor.nextTab": { run: () => cycleTabs(hostKey, workspaceId, 1) },
      "editor.previousTab": { run: () => cycleTabs(hostKey, workspaceId, -1) },
    });
  }, [commands, hostKey, workspaceId, active, current, extraTabs]);
};

type Shown =
  | { readonly kind: "log"; readonly tab: LogTab }
  | { readonly kind: "diff"; readonly tab: DiffTab };

const shownOf = (log: LogTab | undefined, diff: DiffTab | undefined): Shown | null => {
  if (log !== undefined) return { kind: "log", tab: log };

  return diff === undefined ? null : { kind: "diff", tab: diff };
};

/** The strip's tabs, files then diffs then logs, and the diff or log shown instead of a file. */
const useStrip = (
  hostKey: string,
  workspaceId: string,
  fileTabs: ReadonlyArray<TabView>,
  activeId: string | null
) => {
  const logs = useLogTabs(hostKey, workspaceId);
  const logViews = useLogTabViews(logs.tabs);
  const diffs = useDiffTabs(hostKey, workspaceId);
  const extraTabs = useMemo(() => [...diffs.tabs, ...logs.tabs], [diffs.tabs, logs.tabs]);

  const shown = shownOf(
    logs.tabs.find((tab) => tab.id === logs.active),
    diffs.tabs.find((tab) => tab.id === diffs.active)
  );

  return {
    tabs:
      extraTabs.length === 0 ? fileTabs : [...fileTabs, ...diffTabViews(diffs.tabs), ...logViews],
    extraTabs,
    shown,
    current: shown?.tab.id ?? activeId,
  };
};

const ShownBody = ({ shown, root }: { readonly shown: Shown; readonly root: string }) =>
  shown.kind === "log" ? (
    <LogTabBody tab={shown.tab} />
  ) : (
    <DiffTabBody tab={shown.tab} root={root} />
  );

/** Files and their Markdown previews have the file tab menu; logs and diffs have none. */
const isFileTab = (tab: TabView) => tab.view === undefined || tab.view === "markdown";

const theirsOf = (buffer: BufferView | null) =>
  buffer?.status.kind === "ready" ? (buffer.status.model.conflict?.theirs.text ?? null) : null;

export const EditorPane = ({ hostKey, workspaceId, root }: EditorPaneProps) => {
  const connection = useConnection();

  ensureEditor({
    app: () => connection.store.getState(),
    subscribeApp: (changed) => connection.store.subscribe(changed),
  });

  const { tabs: fileTabs, active, activeId, rendered } = useEditorTabs(hostKey, workspaceId);
  const tabStrip = useStrip(hostKey, workspaceId, fileTabs, activeId ?? null);
  const { tabs, extraTabs, shown, current } = tabStrip;
  const actions = tabActions(hostKey, workspaceId);
  const buffer = useBuffer(hostKey, active);

  const { document, epoch, connectionState, hostLabel } = useMarkdownDocument(
    hostKey,
    workspaceId,
    active
  );

  const { openSettings } = useShellActions();
  const [comparing, setComparing] = useState(false);
  const theirs = theirsOf(buffer);

  const agent = useEditor((s) =>
    active === null ? null : (s.agentEdits[workspaceKey(hostKey, workspaceId)]?.get(active) ?? null)
  );

  useEffect(() => {
    setWorkspaceRoot(hostKey, workspaceId, root);
  }, [hostKey, workspaceId, root]);

  // After a restart the tabs come back first; the active one's file loads when shown.
  useEffect(() => {
    if (active !== null && buffer === null) loadTab(hostKey, workspaceId, active);
  }, [hostKey, workspaceId, active, buffer]);

  useEffect(() => {
    if (theirs === null) setComparing(false);
  }, [theirs]);

  useEditorCommands(hostKey, workspaceId, active, current, extraTabs);
  useOpenChanges(hostKey, workspaceId, active);
  useLanguageNavigationCommands();
  usePredictionCommands();
  useLanguageCommands(hostKey, workspaceId, active);

  const onAction = (action: BannerAction) => {
    if (active === null) return;

    const run: Record<BannerAction, () => void> = {
      compare: () => setComparing((c) => !c),
      "keep-mine": () => keepMyEdits(hostKey, active),
      "take-theirs": () => takeDiskVersion(hostKey, active),
      close: () => closeActiveTab(hostKey, workspaceId),
      retry: () => void saveFile(hostKey, active),
      "update-daemon": () => openSettings("hosts"),
      save: () => void saveFile(hostKey, active),
    };

    run[action]();
  };

  const strip = (
    <Tabs
      tabs={tabs}
      active={current ?? active}
      onSelect={actions.select}
      onPin={actions.pin}
      onClose={actions.close}
      menuFor={(tab, selected) =>
        isFileTab(tab) ? tabEntries({ hostKey, workspaceId, root, tabs }, tab, selected) : null
      }
    />
  );

  if (shown !== null) {
    return (
      <section aria-label="Editor" className={PANE_CLASS} data-testid="editor-pane">
        {strip}
        <ShownBody shown={shown} root={root} />
      </section>
    );
  }

  if (fileTabs.length === 0 || active === null) {
    return (
      <section aria-label="Editor" className="grid min-h-0 min-w-0 flex-1 place-items-center">
        <RefactorPreview hostKey={hostKey} root={root} />
        <RefactorRecovery hostKey={hostKey} root={root} />
        <EmptyState
          icon={<PixelFolderIcon size={24} className="text-text-strong" />}
          title="No file open"
          fact={`Pick a file in the explorer, or press ${commandShortcut("editor.findFile")} to find one.`}
        />
      </section>
    );
  }

  const banner = buffer === null ? null : bannerFor(buffer, hostLabel);
  const ready = buffer?.status.kind === "ready";

  const mine =
    comparing && theirs !== null
      ? (viewOf(fileKey(hostKey, active))?.state.sliceDoc() ?? "")
      : null;

  return (
    <section aria-label="Editor" className={PANE_CLASS} data-testid="editor-pane">
      <RefactorPreview hostKey={hostKey} root={root} />
      {strip}
      <PreviewControls
        visible={rendered ?? false}
        hostKey={hostKey}
        workspaceId={workspaceId}
        path={active}
        hostLabel={hostLabel}
        connectionState={connectionState}
        locked={tabs.find((t) => t.id === activeId)?.locked ?? false}
      />
      {agent === null || rendered ? (
        <Breadcrumbs hostKey={hostKey} path={active} root={root} />
      ) : (
        <AgentStrip hostKey={hostKey} edit={agent} />
      )}
      <RefactorRecovery hostKey={hostKey} root={root} />
      {banner === null ? null : (
        <Banner banner={banner} comparing={comparing} onAction={onAction} />
      )}
      {mine !== null && theirs !== null && buffer !== null ? (
        <Compare mine={mine} theirs={theirs} language={buffer.language} />
      ) : null}
      <div className={mine === null ? "relative flex min-h-0 flex-1 flex-col" : "hidden"}>
        {rendered ? null : (
          <EditorTrust hostKey={hostKey} workspaceId={workspaceId} path={active} />
        )}
        {ready ? null : (
          <FileNotice
            buffer={buffer}
            path={active}
            onClose={() => closeActiveTab(hostKey, workspaceId)}
          />
        )}
        {rendered ? (
          <MarkdownBuffer
            key={JSON.stringify([hostKey, active, epoch, connectionState])}
            ready={ready}
            document={document}
            epoch={epoch}
            connectionState={connectionState}
            bufferKey={fileKey(hostKey, active)}
            hostLabel={hostLabel}
          />
        ) : (
          <EditorMenu hostKey={hostKey} workspaceId={workspaceId} root={root} path={active}>
            <CodeHost bufferKey={fileKey(hostKey, active)} ready={ready} focus />
          </EditorMenu>
        )}
      </div>
      <CloseDialog hostKey={hostKey} workspaceId={workspaceId} />
      {rendered ? null : <LanguagePanel hostKey={hostKey} path={active} />}
      <RenameField />
      <SymbolSearch />
    </section>
  );
};
