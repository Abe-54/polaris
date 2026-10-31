/** Data's tab strip, styled as the Editor's (DESIGN.md, Editor: tabs): Table and SQL tabs, closable. */
import { cn, CloseIcon } from "@polaris/ui";
import { closeDataTab, type DataSessionKey, focusDataTab } from "../model/store.ts";
import type { DataTabs } from "../model/tabs.ts";
import { tabTitle } from "./tabKinds.tsx";

export const TabStrip = ({ at, state }: { at: DataSessionKey; state: DataTabs }) => (
  <div
    role="tablist"
    aria-label="Open tables and queries"
    className="border-hairline flex h-[46px] shrink-0 [scrollbar-width:none] items-center gap-1 overflow-x-auto border-b px-2"
  >
    {state.tabs.map((tab) => {
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
            if (event.button === 1) closeDataTab(tab.id, at);
          }}
          onClick={() => focusDataTab(tab.id, at)}
          onKeyDown={(event) => {
            if (event.key === "Delete" || event.key === "Backspace") closeDataTab(tab.id, at);
          }}
          className={cn(
            "group/tab flex h-[30px] max-w-[240px] shrink-0 cursor-default items-center gap-2 rounded-full pr-2.5 pl-3 text-label select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-starlight",
            selected
              ? "bg-fill-selected text-text-strong"
              : "text-text-subtle hover:bg-fill-hover hover:text-text-default"
          )}
        >
          <span className="truncate">{title}</span>
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Close ${title}`}
            onClick={(event) => {
              event.stopPropagation();
              closeDataTab(tab.id, at);
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
);
