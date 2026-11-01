import { Button, Kbd, PlusIcon, SearchIcon, SegmentedControl, Wordmark } from "@polaris/ui";
import type { Route } from "../../shared/api.ts";
import { isWindows } from "../../shared/platform.ts";
import { useRequestedCount } from "../features/pulls/store.ts";
import { NeedsYouPopover, useNeedsYouCount } from "../features/needs-you/index.ts";
import { useTracesUnavailable } from "../features/traces/index.ts";
import { jumpCopy } from "../features/jump/copy.ts";
import { useSelection, useShellActions } from "./hooks.ts";
import { preloadEditor } from "../features/editor/preload.ts";
import { OfflineIndicator } from "./HostState.tsx";
import { AppMenuButton, CaptionSpace } from "./windowsChrome.tsx";

/**
 * The title bar (DESIGN.md, Titlebar; Chrome redesign): on the ground with no fill. On macOS
 * the lockup after the traffic lights; on Windows the lockup as the app menu, with the native
 * caption buttons over the right end. Then the mode pill tabs (⌘1–5), the offline indicator,
 * the jump pill (K) and, outside Review, New session (⌘N) in Starlight. While Settings is open
 * no mode is selected; picking one leaves Settings for it.
 */
export const TitleBar = () => {
  const windows = isWindows();
  const { mode, hostKey, settings } = useSelection();
  const { setMode, openJump, startNewSession } = useShellActions();
  const waiting = useNeedsYouCount();
  const requested = useRequestedCount();
  const tracesUnavailable = useTracesUnavailable(hostKey);

  const modes: ReadonlyArray<{
    readonly value: Route;
    readonly label: React.ReactNode;
    readonly badge?: React.ReactNode;
    readonly disabled?: boolean;
  }> = [
    {
      value: "orchestrate",
      label: "Orchestrate",
      badge:
        waiting > 0 ? (
          <NeedsYouPopover>
            <span
              aria-label={`${waiting} need you`}
              // Paper 11U-0: 18px, radius 6, 5px sides, the needs-you wash.
              className="rounded-control bg-needs-you/12 text-micro text-needs-you-text tabular flex h-[18px] min-w-[18px] items-center justify-center px-[5px] font-medium"
            >
              {waiting}
            </span>
          </NeedsYouPopover>
        ) : undefined,
    },
    {
      value: "review",
      label: "Review",
      badge:
        requested > 0 ? (
          // Paper R3: a plain count, no wash; review requests aren't sessions that need you.
          <span
            aria-label={`${requested} review requested`}
            className="text-micro text-text-subtle tabular"
          >
            {requested}
          </span>
        ) : undefined,
    },
    { value: "edit", label: "Edit" },
    { value: "data", label: "Data" },
    {
      value: "traces",
      // A disabled segment still shows its title, so the reason is on hover.
      label: <span title={tracesUnavailable ?? undefined}>Traces</span>,
      disabled: tracesUnavailable !== null,
    },
  ];

  return (
    <header
      className={`app-drag flex h-13 shrink-0 items-center gap-5 ${windows ? "pl-3" : "pr-4 pl-4"}`}
    >
      {windows ? (
        <AppMenuButton />
      ) : (
        <>
          {/* The native traffic lights sit here (window.ts); fixed, never density-scaled. */}
          <span className="w-[60px] shrink-0" aria-hidden />
          <Wordmark />
        </>
      )}
      {/* Reaching for the switch warms Edit mode, so its first open is quick. */}
      <div className="app-no-drag flex" onPointerEnter={preloadEditor} onFocus={preloadEditor}>
        <SegmentedControl
          aria-label="Mode"
          pill
          options={modes}
          value={settings === null ? mode : null}
          onValueChange={setMode}
        />
      </div>
      <span className="flex-1" />
      <OfflineIndicator />
      <button
        type="button"
        onClick={openJump}
        className="app-no-drag bg-panel text-body text-text-faint flex h-[34px] w-[300px] shrink-0 cursor-default items-center gap-2.5 rounded-full pr-1.5 pl-3.5"
      >
        <SearchIcon size={14} />
        <span className="flex-1 truncate text-left">{jumpCopy(mode).placeholder}</span>
        <Kbd>K</Kbd>
      </button>
      {/* Review has no New session (Paper R1); ⌘N still starts one. */}
      {mode !== "review" && (
        // Starlight fills New session and Send, nothing else (DESIGN.md, Chrome redesign: Controls).
        <Button
          variant="primary"
          className="app-no-drag bg-starlight hover:bg-starlight/90 h-[34px] gap-2 rounded-full pr-4 pl-[13px] font-medium text-[light-dark(#ffffff,#0d1830)]"
          disabled={hostKey === null}
          onClick={startNewSession}
        >
          <PlusIcon size={14} />
          New session
        </Button>
      )}
      {/* Windows draws its caption buttons over this space (main/chrome.ts). */}
      {windows && <CaptionSpace />}
    </header>
  );
};
