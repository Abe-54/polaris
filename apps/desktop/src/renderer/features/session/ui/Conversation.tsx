/**
 * The conversation, virtualized: only rows near the viewport are in the DOM,
 * positioned by the virtualizer directly (no React render per scroll frame).
 * It follows the end while pinned there (`follow.ts`), offers the jump-to-latest
 * arrow once the user scrolls away, and opens at the end with its measurements kept.
 * `reveal` scrolls a row into the middle (⌘F, the Turn rail).
 */
import { cn, reducedMotion } from "@polaris/ui";
import { useVirtualizer, type Virtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Row } from "../model/conversation.ts";
import { arrivedBelow, type JumpControl, tailOf, watchFollow } from "./follow.ts";
import { JumpToLatest } from "./JumpToLatest.tsx";
import { preloadMarkdown } from "./markdown/index.tsx";
import { OverlayScrollbar } from "./overlayScrollbar.tsx";
import { REVEAL_APPROVAL } from "../../../shell/approvalInView.ts";
import { ConversationRow, type RowContext } from "./rows.tsx";

const saved = new Map<string, ReadonlyArray<VirtualItem>>();

const ESTIMATE = 64;

/** Pinned, every resize and append keeps the end in view; released, none does. */
const FOLLOW = Number.POSITIVE_INFINITY;

const RELEASED = -1;

/** A row to bring into view; a new `nonce` asks again for the same row. */
export interface Reveal {
  readonly key: string;
  readonly nonce: number;
  /** Where the row lands: the middle (a find match) or the top (a Turn from the rail). */
  readonly align?: "center" | "start";
}

export interface ConversationProps {
  /** Where to keep this list's measurements between visits (the session's key). */
  readonly scrollKey: string;
  readonly rows: ReadonlyArray<Row>;
  readonly ctx: RowContext;
  readonly reveal?: Reveal | null;
  /** Rows rendered now (the virtualizer's range), on every scroll: keep the work cheap. */
  readonly onRange?: (start: number, end: number) => void;
  /** Room on the right for the Turn rail. */
  readonly gutter?: boolean;
  /** The first Turn listed: when older Turns land above it, the list keeps its place. */
  readonly firstTurnId?: string | null;
  /** Where the Transcript's jump-to-latest command reaches the list. */
  readonly jump?: JumpControl;
}

/** The row at the top of the viewport, and how far its start sits from it. */
interface Anchor {
  readonly key: string | number | bigint;
  readonly offset: number;
}

interface Pin {
  readonly on: () => boolean;
  readonly set: (on: boolean) => void;
  readonly jump: () => void;
}

/** The pin, told to the virtualizer at once, before React renders the arrow. */
const createPin = (
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  onChange: (on: boolean) => void
): Pin => {
  let on = true;
  let jumping = false;

  const set = (next: boolean) => {
    if (next === on) return;
    on = next;
    virtualizer.setOptions({
      ...virtualizer.options,
      scrollEndThreshold: next ? FOLLOW : RELEASED,
    });

    // Scrolling up mid-jump stops the jump, which would otherwise chase a growing end.
    if (!next && jumping) virtualizer.scrollToOffset(virtualizer.scrollOffset ?? 0);
    jumping = false;
    onChange(next);
  };

  return {
    on: () => on,
    set,
    jump: () => {
      set(true);
      jumping = !reducedMotion();
      virtualizer.scrollToEnd({ behavior: jumping ? "smooth" : "auto" });
    },
  };
};

export const Conversation = ({
  scrollKey,
  rows,
  ctx,
  reveal = null,
  onRange,
  gutter = false,
  firstTurnId = null,
  jump,
}: ConversationProps) => {
  const anchor = useRef<Anchor | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const restore = saved.get(scrollKey);
  const [pinned, setPinned] = useState(true);
  const [fresh, setFresh] = useState(false);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATE,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 6,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: pinned ? FOLLOW : RELEASED,
    paddingStart: 20,
    paddingEnd: 20,
    directDomUpdates: true,
    onChange: (instance) => {
      if (instance.range !== null) onRange?.(instance.range.startIndex, instance.range.endIndex);
    },
    initialMeasurementsCache: restore === undefined ? [] : [...restore],
    initialOffset: Number.MAX_SAFE_INTEGER,
  });

  const pin = useMemo(
    () =>
      createPin(virtualizer, (on) => {
        setPinned(on);

        if (on) setFresh(false);
      }),
    [virtualizer]
  );

  useEffect(preloadMarkdown, []);

  // The host around the list and its scrollbar: a wheel or drag there is the user's too.
  useEffect(() => {
    const list = scrollRef.current;
    const host = list?.parentElement;

    if (list === null || host === null || host === undefined) return;

    return watchFollow(list, host, {
      pinned: pin.on,
      setPinned: pin.set,
      keepEnd: () => virtualizer.scrollToEnd(),
    });
  }, [pin, virtualizer]);

  useEffect(() => {
    return jump?.bind({ run: pin.jump, available: () => !pin.on() });
  }, [jump, pin]);

  // An approval asked to show itself (Approve from elsewhere): release the end, its row on top.
  useEffect(() => {
    const list = scrollRef.current;

    if (list === null) return;

    const reveal = (event: Event) => {
      const row = event.target instanceof Element ? event.target.closest("[data-index]") : null;
      const index = Number(row?.getAttribute("data-index") ?? Number.NaN);

      if (!Number.isInteger(index)) return;
      event.preventDefault();
      pin.set(false);
      virtualizer.scrollToIndex(index, { align: "start" });
    };

    list.addEventListener(REVEAL_APPROVAL, reveal);

    return () => list.removeEventListener(REVEAL_APPROVAL, reveal);
  }, [pin, virtualizer]);

  const tail = useRef(tailOf(rows, firstTurnId));

  // Rows arriving below while released mark the arrow; a page landing above doesn't.
  useEffect(() => {
    const next = tailOf(rows, firstTurnId);

    if (!pin.on() && arrivedBelow(tail.current, next)) setFresh(true);
    tail.current = next;
  }, [rows, firstTurnId, pin]);

  // The anchor follows scrolling only: rows changing (a page landing) must not move it.
  useEffect(() => {
    const list = scrollRef.current;

    if (list === null) return;

    const record = () => {
      const top = list.scrollTop;

      // The "older" row leaves once the last page lands, so it never holds the place.
      const first = virtualizer
        .getVirtualItems()
        .find((item) => item.end > top && item.key !== "older");

      anchor.current = first === undefined ? null : { key: first.key, offset: first.start - top };
    };

    list.addEventListener("scroll", record, { passive: true });

    return () => list.removeEventListener("scroll", record);
  }, [virtualizer]);

  const shownFirst = useRef(firstTurnId);

  // Older Turns landed above: scroll by what they added, so the row on top stays on top.
  useLayoutEffect(() => {
    if (shownFirst.current === firstTurnId) return;
    shownFirst.current = firstTurnId;
    const held = anchor.current;
    const index = held === null ? -1 : rows.findIndex((r) => r.key === held.key);
    const start = index === -1 ? undefined : virtualizer.getOffsetForIndex(index, "start")?.[0];

    if (held !== null && start !== undefined) virtualizer.scrollToOffset(start - held.offset);
  }, [firstTurnId, rows, virtualizer]);

  const revealed = useRef<number | null>(null);

  // The row may appear only after its Turn opens, so this waits for it in `rows`.
  useEffect(() => {
    if (reveal === null || revealed.current === reveal.nonce) return;
    const index = rows.findIndex((r) => r.key === reveal.key);

    if (index === -1) return;
    revealed.current = reveal.nonce;
    pin.set(false);
    virtualizer.scrollToIndex(index, { align: reveal.align ?? "center" });
  }, [reveal, rows, virtualizer, pin]);

  // Streaming grows the last row: `anchorTo: "end"` follows it as the row is re-measured.
  // No per-commit isAtEnd/scrollToEnd: each one forces a layout of the whole list.
  useEffect(
    () => () => {
      saved.set(scrollKey, virtualizer.takeSnapshot());
    },
    [scrollKey, virtualizer]
  );

  // The parent positions the overlay scrollbar and the arrow: it must be `relative` around the list.
  return (
    <>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 [scrollbar-width:none] overflow-y-auto overscroll-contain select-text [overflow-anchor:none]"
        data-testid="conversation"
        data-approval-viewport
      >
        <div ref={virtualizer.containerRef} className="relative w-full">
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];

            return row === undefined ? null : (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                data-row-key={row.key}
                className={cn(
                  "pb-panel absolute top-0 left-0 w-full pl-5",
                  gutter ? "pr-10" : "pr-5"
                )}
              >
                <ConversationRow row={row} ctx={ctx} />
              </div>
            );
          })}
        </div>
      </div>
      <OverlayScrollbar list={scrollRef} />
      <JumpToLatest
        shown={!pinned}
        fresh={fresh}
        working={ctx.liveTurnId === null ? null : ctx.harness}
        onJump={pin.jump}
      />
    </>
  );
};
