/**
 * Data's tab strip, styled as the Editor's (DESIGN.md, Editor: tabs): Table and SQL tabs, closable;
 * a tab with staged edits asks before it closes.
 * One tab stop; ←/→, Home and End move to a tab and select it.
 */
import { cn, CloseIcon } from "@polaris/ui";
import { type KeyboardEvent, useRef } from "react";
import { type DataSessionKey, focusDataTab } from "../model/store.ts";
import type { DataTabs } from "../model/tabs.ts";
import { tabTitle } from "./tabKinds.tsx";
import { CloseStaged, requestCloseTab } from "./table/edits/CloseStaged.tsx";

/** The tab index a key moves to from `at`, wrapping at the ends; null for other keys. */
export const tabKeyTarget = (count: number, at: number, key: string): number | null => {
  if (count === 0) return null;

  switch (key) {
    case "ArrowRight":
      return (at + 1) % count;
    case "ArrowLeft":
      return (at - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
};

export const TabStrip = ({ at, state }: { at: DataSessionKey; state: DataTabs }) => {
  const strip = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent, index: number, id: string) => {
    if (event.key === "Delete" || event.key === "Backspace") return requestCloseTab(at, id);
    const target = tabKeyTarget(state.tabs.length, index, event.key);
    const tab = target === null ? undefined : state.tabs[target];

    if (target === null || tab === undefined) return;
    event.preventDefault();
    focusDataTab(tab.id, at);
    strip.current?.querySelectorAll<HTMLElement>('[role="tab"]')[target]?.focus();
  };

  return (
    <>
      <div
        ref={strip}
        role="tablist"
        aria-label="Open tables and queries"
        className="border-hairline flex h-[46px] shrink-0 [scrollbar-width:none] items-center gap-1 overflow-x-auto border-b px-2"
      >
        {state.tabs.map((tab, index) => {
          const selected = tab.id === state.active;
          const title = tabTitle(tab);

          return (
            <div
              key={tab.id}
              role="tab"
              tabIndex={selected ? 0 : -1}
              aria-selected={selected}
              data-testid="data-tab"
              data-kind={tab.kind}
              onMouseDown={(event) => {
                if (event.button === 1) requestCloseTab(at, tab.id);
              }}
              onClick={() => focusDataTab(tab.id, at)}
              onKeyDown={(event) => onKeyDown(event, index, tab.id)}
              className={cn(
                "group/tab flex h-[30px] max-w-[240px] shrink-0 cursor-default items-center gap-2 rounded-full pr-2.5 pl-3 text-label select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-starlight",
                selected
                  ? "bg-fill-selected text-text-strong"
                  : "text-text-subtle hover:bg-fill-hover hover:text-text-default"
              )}
            >
              <span className="truncate" dir="auto">
                {title}
              </span>
              <button
                type="button"
                tabIndex={-1}
                aria-label={`Close ${title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  requestCloseTab(at, tab.id);
                }}
                className={cn(
                  "text-text-subtle hover:text-text-default flex size-3 items-center justify-center rounded-[3px]",
                  selected ? "visible" : "invisible group-hover/tab:visible"
                )}
              >
                <CloseIcon size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <CloseStaged at={at} tabs={state} titleOf={tabTitle} />
    </>
  );
};
