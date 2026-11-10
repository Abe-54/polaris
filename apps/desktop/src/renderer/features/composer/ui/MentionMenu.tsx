/**
 * The list above the composer while an `@` word is typed: folders, then files
 * in the session's directory, as the Host's file index ranks them. Drawn like
 * the `/` menu; the editor keeps focus and owns ↑ ↓ ↵ ⇥ esc. Virtualized.
 */
import { cn, ICON_MASKS, REVEAL_MOTION } from "@polaris/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type CSSProperties, useEffect, useRef } from "react";
import type { MentionRow } from "../model/mentions.ts";

export interface MentionMenuProps {
  /** Empty while the first answer is read, or when the search failed. */
  readonly rows: ReadonlyArray<MentionRow>;
  readonly failed: string | null;
  readonly active: number;
  readonly onPick: (index: number) => void;
  readonly onHover: (index: number) => void;
}

const ROW_HEIGHT = 30;

const Row = ({
  row,
  selected,
  onPick,
  onHover,
}: {
  readonly row: MentionRow;
  readonly selected: boolean;
  readonly onPick: () => void;
  readonly onHover: () => void;
}) => (
  <div
    role="option"
    aria-selected={selected}
    aria-label={row.path}
    data-selected={selected ? "" : undefined}
    data-testid="mention-row"
    // The editor keeps focus: a mouse press must not move it.
    onMouseDown={(event) => {
      event.preventDefault();
      onPick();
    }}
    onMouseMove={onHover}
    className={cn(
      "rounded-row px-row-x flex h-full cursor-default items-center gap-2.5 select-none",
      selected && "bg-fill-selected"
    )}
  >
    <span
      aria-hidden="true"
      className="mention-icon"
      data-selected={selected ? "" : undefined}
      // SAFETY: React passes custom properties through `style`; its type only lacks the name.
      style={{ "--chip-icon": ICON_MASKS[row.kind] } as CSSProperties}
    />
    <span
      className={cn(
        "text-label shrink-0 truncate font-medium",
        selected ? "text-text-strong" : "text-text-default"
      )}
    >
      {row.kind === "folder" ? `${row.name}/` : row.name}
    </span>
    {row.parent === "" ? null : (
      <span className="text-caption text-text-subtle min-w-0 truncate [direction:rtl]">
        <bdi>{row.parent}</bdi>
      </span>
    )}
  </div>
);

const CARD =
  "rounded-card border-hairline bg-surface-raised shadow-float max-w-[560px] border p-1.5";

export const MentionMenu = ({ rows, failed, active, onPick, onHover }: MentionMenuProps) => {
  const list = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => list.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.path ?? index,
    overscan: 12,
    // The list's own cap, until it is measured: the first rows draw on the first frame.
    initialRect: { width: 560, height: 320 },
  });

  // Keeps the highlighted row in view as ↑ ↓ move it.
  useEffect(() => {
    if (rows.length > 0) virtualizer.scrollToIndex(active, { align: "auto" });
  }, [active, rows.length, virtualizer]);

  if (rows.length === 0)
    return (
      <div role="status" aria-live="polite" className={cn(REVEAL_MOTION, CARD)}>
        <p className="text-caption text-text-subtle px-row-x py-1.5">
          {failed ?? "Searching files…"}
        </p>
      </div>
    );

  return (
    <div
      ref={list}
      role="listbox"
      aria-label="Files and folders"
      data-testid="mention-menu"
      className={cn(
        REVEAL_MOTION,
        CARD,
        "max-h-[var(--menu-room,min(320px,40vh))] overflow-y-auto"
      )}
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];

          return row === undefined ? null : (
            <div
              key={item.key}
              className="absolute top-0 left-0 w-full"
              style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
            >
              <Row
                row={row}
                selected={item.index === active}
                onPick={() => onPick(item.index)}
                onHover={() => onHover(item.index)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};
