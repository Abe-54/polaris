/**
 * The tab strip (DESIGN.md, Editor: tabs; Paper E1): 36px tabs in `label`
 * type, the active one joined to the code, a dot for unsaved edits, a close
 * mark on the active tab, and a 12px dither while an agent changes the file.
 */
import {
  cn,
  CloseIcon,
  ContextMenu,
  ContextMenuContent,
  ContextMenuEntries,
  ContextMenuTrigger,
  Dither,
  type MenuEntryInput,
} from "@polaris/ui";
import { type MouseEvent, type ReactElement, useEffect, useRef } from "react";
import { EDGE_FADE, useEdgeFade } from "../../../shell/edgeFade.ts";
import type { TabView } from "../runtime/hooks.ts";

export interface TabsProps {
  readonly tabs: ReadonlyArray<TabView>;
  readonly active: string | null;
  readonly onSelect: (path: string) => void;
  readonly onPin: (path: string) => void;
  readonly onClose: (path: string) => void;
  /** A tab's right-click menu; none when unset. */
  readonly menuFor?: (tab: TabView, selected: boolean) => ReadonlyArray<MenuEntryInput> | null;
}

const TabMenu = ({
  entries,
  children,
}: {
  readonly entries: ReadonlyArray<MenuEntryInput> | null;
  readonly children: ReactElement;
}) =>
  entries === null ? (
    children
  ) : (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent data-testid="editor-tab-menu">
        <ContextMenuEntries entries={entries} />
      </ContextMenuContent>
    </ContextMenu>
  );

/** The trailing 12px slot: the unsaved dot, swapped for the close mark on hover or when active. */
const TrailingSlot = ({
  tab,
  active,
  onClose,
}: {
  tab: TabView;
  active: boolean;
  onClose: () => void;
}) => {
  const close = (event: MouseEvent) => {
    event.stopPropagation();
    onClose();
  };

  return (
    <span className="relative flex size-3 shrink-0 items-center justify-center">
      {tab.dirty ? (
        <span
          aria-label="Unsaved"
          className="bg-text-subtle size-1.5 rounded-full group-hover/tab:invisible"
        />
      ) : null}
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Close ${tab.label}`}
        onClick={close}
        className={cn(
          "absolute inset-0 flex items-center justify-center rounded-[3px] text-text-subtle hover:text-text-default",
          active && !tab.dirty ? "visible" : "invisible group-hover/tab:visible"
        )}
      >
        <CloseIcon size={12} />
      </button>
    </span>
  );
};

export const Tabs = ({ tabs, active, onSelect, onPin, onClose, menuFor }: TabsProps) => {
  const strip = useRef<HTMLDivElement>(null);

  useEdgeFade(strip);

  // The active tab stays in view however many are open.
  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);

  // The fade masks the tabs only, so the strip's hairline runs edge to edge.
  return (
    <div className="border-hairline flex h-[46px] shrink-0 border-b">
      <div
        ref={strip}
        role="tablist"
        aria-label="Open files"
        className={cn(
          "flex min-w-0 flex-1 [scrollbar-width:none] items-center gap-1 overflow-x-auto px-2",
          EDGE_FADE
        )}
      >
        {tabs.map((tab) => {
          const selected = tab.id === active;

          return (
            <TabMenu key={tab.id} entries={menuFor?.(tab, selected) ?? null}>
              <div
                role="tab"
                tabIndex={selected ? 0 : -1}
                aria-selected={selected}
                title={tab.path}
                data-testid="editor-tab"
                data-view={tab.view ?? "source"}
                data-dirty={tab.dirty ? "" : undefined}
                onMouseDown={(event) => {
                  if (event.button === 1) onClose(tab.id);
                }}
                onClick={() => onSelect(tab.id)}
                onDoubleClick={() => {
                  if (tab.view === undefined || tab.view === "diff") onPin(tab.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(tab.id);
                  }

                  if (event.key === "Delete" || event.key === "Backspace") {
                    event.preventDefault();
                    onClose(tab.id);
                  }

                  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                    event.preventDefault();
                    const at = tabs.findIndex((t) => t.id === tab.id);

                    let index =
                      (at + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;

                    if (event.key === "Home") index = 0;

                    if (event.key === "End") index = tabs.length - 1;
                    const next = tabs[index];

                    if (next !== undefined) {
                      onSelect(next.id);
                      strip.current?.querySelectorAll<HTMLElement>('[role="tab"]')[index]?.focus();
                    }
                  }
                }}
                className={cn(
                  "group/tab flex h-[30px] max-w-[240px] shrink-0 cursor-default focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-starlight items-center gap-2 rounded-full pr-2.5 pl-3 text-label select-none",
                  selected
                    ? "bg-fill-selected text-text-strong"
                    : "text-text-subtle hover:bg-fill-hover hover:text-text-default"
                )}
              >
                {tab.agent === null ? null : <Dither hue={tab.agent} size={12} moving />}
                <span className={cn("truncate", tab.preview && "italic")}>{tab.label}</span>
                {tab.detail === undefined ? null : (
                  <span className="text-caption text-text-subtle shrink-0">{tab.detail}</span>
                )}
                <TrailingSlot tab={tab} active={selected} onClose={() => onClose(tab.id)} />
              </div>
            </TabMenu>
          );
        })}
      </div>
    </div>
  );
};
