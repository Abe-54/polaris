/** Layout F: title bar, the adaptive top bar, then Input → Intent → Output (ENG-177). */
import { cn, Horizon } from "@polaris/ui";
import { useEffect, useState } from "react";
import { FileFinder, WorkspaceSearch } from "../features/editor-finder/index.ts";
import { EditorRequests } from "../features/editor-links/index.ts";
import { LazyInline } from "../features/editor-inline/index.ts";
import { useOnboardingState, Welcome } from "../features/onboarding/index.ts";
import { DataMode } from "../features/data/index.ts";
import { TracesMode } from "../features/traces/index.ts";
import { EditMode } from "../features/editor/explorer/index.ts";
import { Arcade } from "../features/arcade/index.ts";
import { CommandPalette } from "../features/palette/index.ts";
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

/** Review: the subject open (`routes/review.ts`), or the pull request list. */
const Review = () => {
  const subject = useReviewSubject();
  const { openSettings } = useShellActions();

  // The Review view's chunk loads while the pull request list is on screen.
  useEffect(preloadReview, []);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      {subject === null ? (
        <slots.PullRequests onAddAccount={() => openSettings("github", { adding: true })} />
      ) : (
        <slots.ReviewSubject subject={subject} onBack={closeReviewSubject} />
      )}
    </main>
  );
};

/** Settings replaces the three zones (DESIGN.md, Settings); otherwise the mode's view. */
const Body = () => {
  const { mode, settings } = useSelection();

  if (settings !== null) return <SettingsPage route={settings} />;

  if (mode === "review") return <Review />;

  if (mode === "edit") return <EditMode />;

  if (mode === "data") return <DataMode />;

  if (mode === "traces") return <TracesMode />;

  // Panels on a ground, the horizon behind them along the window's foot (DESIGN.md, Chrome redesign).
  return (
    <div className="relative isolate flex min-h-0 flex-1 flex-col">
      <TopBar />
      <main className="flex min-h-0 flex-1 gap-2 pr-2">
        <Sidebar />
        <Columns />
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
