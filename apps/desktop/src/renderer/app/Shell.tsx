/** Layout F: title bar, the adaptive top bar, then Input → Intent → Output (ENG-177). */
import { cn, Horizon } from "@polaris/ui";
import { useEffect, useState } from "react";
import { FileFinder, WorkspaceSearch } from "../features/editor-finder/index.ts";
import { EditorRequests } from "../features/editor-links/index.ts";
import { LazyInline } from "../features/editor-inline/index.ts";
import { useOnboardingState, Welcome } from "../features/onboarding/index.ts";
import { DataMode } from "../features/data/index.ts";
import { TracesMode } from "../features/traces/index.ts";
import { RequestsMode } from "../features/requests/index.ts";
import { EditMode } from "../features/editor/explorer/index.ts";
import { Arcade } from "../features/arcade/index.ts";
import { CommandPalette } from "../features/palette/index.ts";
import { PaneBoundary } from "../features/crash/index.ts";
import { preloadReview } from "../features/review/index.ts";
import { SettingsPage } from "../features/settings/index.ts";
import { useTerminalKey } from "../features/terminal/index.ts";
import { closeReviewSubject, useReviewSubject } from "../routes/review.ts";
import { Columns } from "../shell/Columns.tsx";
import { ShortcutHelp } from "../shell/ShortcutHelp.tsx";
import { useNav, useSelection, useShellActions } from "../shell/hooks.ts";
import { Sidebar } from "../shell/sidebar/Sidebar.tsx";
import { TitleBar } from "../shell/TitleBar.tsx";
import { TopBar } from "../shell/TopBar.tsx";
import { slots } from "./slots.tsx";

const MODE_VIEWS = {
  edit: EditMode,
  data: DataMode,
  traces: TracesMode,
  requests: RequestsMode,
} as const;

/** Review: the subject open (`routes/review.ts`), or the pull request list. */
const Review = () => {
  const subject = useReviewSubject();
  const { openSettings } = useShellActions();

  // The Review view's chunk loads while the pull request list is on screen.
  useEffect(preloadReview, []);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PaneBoundary pane="review" resetOn={subject}>
        {subject === null ? (
          <slots.PullRequests onAddAccount={() => openSettings("github", { adding: true })} />
        ) : (
          <slots.ReviewSubject subject={subject} onBack={closeReviewSubject} />
        )}
      </PaneBoundary>
    </main>
  );
};

/**
 * Settings replaces the three zones (DESIGN.md, Settings); otherwise the mode's view. Each pane
 * has its own keyed boundary, so a crash stays in it (ENG-757).
 */
const Body = () => {
  const { mode, settings, sessionId } = useSelection();

  if (settings !== null) {
    return (
      <PaneBoundary key="settings" pane="settings">
        <SettingsPage route={settings} />
      </PaneBoundary>
    );
  }

  if (mode === "review") return <Review key="review" />;

  if (mode === "edit" || mode === "data" || mode === "traces" || mode === "requests") {
    const View = MODE_VIEWS[mode];

    return (
      <PaneBoundary key={mode} pane={mode}>
        <View />
      </PaneBoundary>
    );
  }

  // Panels on a ground, the horizon behind them along the window's foot (DESIGN.md, Chrome redesign).
  return (
    <div className="relative isolate flex min-h-0 flex-1 flex-col">
      <TopBar />
      <main className="flex min-h-0 flex-1 gap-2 pr-2">
        <Sidebar />
        <PaneBoundary pane="session" resetOn={sessionId}>
          <Columns />
        </PaneBoundary>
      </main>
      <Horizon />
    </div>
  );
};

/** In Edit, toasts also clear the status bar under the Terminal strip (DESIGN.md, Toasts). */
const useEditToastInset = () => {
  const edit = useSelection().mode === "edit";

  useEffect(() => {
    if (!edit) return;
    const root = document.documentElement.style;

    root.setProperty("--toast-inset-bottom", "70px");

    return () => {
      root.removeProperty("--toast-inset-bottom");
    };
  }, [edit]);
};

/** The selection bar, ⌘I and ⌘L live with the editor: mounted, and loaded, only in Edit. */
const InlineInEdit = () => (useSelection().mode === "edit" ? <LazyInline /> : null);

export const Shell = () => {
  const jumpOpen = useNav((s) => s.jumpOpen);
  const { setJumpOpen } = useShellActions();

  useTerminalKey();
  useEditToastInset();
  const welcome = useOnboardingState((s) => s.welcome);
  // Set once Welcome has shown in this window, so only the shell that follows it fades in.
  const [justOnboarded, setJustOnboarded] = useState(false);

  if (welcome === "show" && !justOnboarded) setJustOnboarded(true);

  // Until the settings say, a plain frame: the welcome never flashes for a returning user.
  if (welcome === "unknown") return <div className="bg-ground h-full" />;

  if (welcome === "show") return <Welcome />;

  return (
    <div
      className={cn(
        "bg-ground flex h-full flex-col",
        justOnboarded && "animate-in fade-in-0 duration-200 ease-out"
      )}
    >
      <TitleBar />
      <Body />
      <slots.JumpMenu open={jumpOpen} onOpenChange={setJumpOpen} />
      <CommandPalette />
      <Arcade />
      <slots.OpenFolder />
      <ShortcutHelp />
      <FileFinder />
      <WorkspaceSearch />
      <InlineInEdit />
      <EditorRequests />
    </div>
  );
};
