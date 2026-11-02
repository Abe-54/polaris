/**
 * The Turn rail (DESIGN.md, Turn rail; Paper 8, 8b): a tick per Turn down the
 * conversation's right edge. Ticks near the pointer lengthen in an arc (140ms
 * ease-out, `transform` only), the pointed Turn previews its prompt, and a click
 * jumps to it. Keyboard: Tab in, ↑/↓ move, ↵ jumps. Reduce Motion drops the arc.
 */
import { cn } from "@polaris/ui";
import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { TurnView } from "../../../store/sessionModel.ts";
import { plural } from "../model/format.ts";
import { type Row, turnTime } from "../model/conversation.ts";
import {
  LONGEST,
  type RailTurn,
  railLayout,
  railTurns,
  tickLength,
  tickTurn,
  turnAt,
  turnsInView,
} from "../model/rail.ts";

/** The rows on screen, pushed by the conversation on scroll and read by the rail. */
export interface RowRange {
  readonly emit: (start: number, end: number) => void;
  readonly subscribe: (listener: (start: number, end: number) => void) => () => void;
}

export const createRowRange = (): RowRange => {
  const listeners = new Set<(start: number, end: number) => void>();
  // Null until the list has said what it renders.
  let last: readonly [number, number] | null = null;

  return {
    emit: (start, end) => {
      if (last !== null && last[0] === start && last[1] === end) return;
      last = [start, end];

      for (const listener of listeners) listener(start, end);
    },
    subscribe: (listener) => {
      listeners.add(listener);

      if (last !== null) listener(last[0], last[1]);

      return () => listeners.delete(listener);
    },
  };
};

/** The app's Motion setting, else the system's Reduce Motion (as `@polaris/ui`'s motion helper). */
const still = () => {
  const setting = document.documentElement.dataset.reduceMotion;

  return setting === undefined
    ? matchMedia("(prefers-reduced-motion: reduce)").matches
    : setting === "true";
};

/** `still()`, kept current when the setting or the system preference changes. */
const subscribeStill = (onChange: () => void) => {
  const media = matchMedia("(prefers-reduced-motion: reduce)");
  const observer = new MutationObserver(onChange);

  observer.observe(document.documentElement, { attributeFilter: ["data-reduce-motion"] });
  media.addEventListener("change", onChange);

  return () => {
    observer.disconnect();
    media.removeEventListener("change", onChange);
  };
};

interface Pointed {
  /** The Turn's index, and the tick that stands for it. */
  readonly turn: number;
  readonly tick: number;
  readonly by: "pointer" | "keyboard";
}

const InView = { first: -1, last: -1 };

/** The track's padding above the first tick (`py-1`). */
const PAD = 4;

/** Which Turns are on screen, re-rendering only when that changes, not per scroll frame. */
const useInView = (
  range: RowRange,
  rows: ReadonlyArray<Row>,
  turnIndex: ReadonlyMap<string, number>
) => {
  const [inView, setInView] = useState(InView);

  useEffect(() => {
    return range.subscribe((start, end) => {
      const next = turnsInView(rows, start, end, turnIndex) ?? InView;

      setInView((prev) => (prev.first === next.first && prev.last === next.last ? prev : next));
    });
  }, [range, rows, turnIndex]);

  return inView;
};

/** The height the rail may take: the conversation's, less a margin above and below. */
const useRoom = (track: RefObject<HTMLDivElement | null>) => {
  const [room, setRoom] = useState(0);

  useEffect(() => {
    const host = track.current?.parentElement?.parentElement;

    if (host === null || host === undefined) return;
    const observer = new ResizeObserver(() => setRoom(Math.max(0, host.clientHeight - 64)));

    observer.observe(host);

    return () => observer.disconnect();
  }, [track]);

  return room;
};

const Preview = ({ turn, top }: { turn: RailTurn; top: number }) => {
  const time = turnTime(turn.startedAt, new Date());

  return (
    <div
      className="rounded-row border-hairline bg-surface-raised shadow-float pointer-events-none absolute right-full mr-2 flex w-[264px] -translate-y-1/2 flex-col gap-1 border px-3 py-2.5"
      style={{ top }}
      data-testid="turn-rail-preview"
    >
      <p className="text-caption text-text-subtle tabular flex gap-1.5 whitespace-nowrap">
        <span className="text-text-strong font-medium">Turn {turn.number}</span>
        {time === "" ? null : <span>· {time}</span>}
        {turn.files === 0 ? null : <span>· {plural(turn.files, "file")}</span>}
      </p>
      <p className="text-body text-text-default line-clamp-3 break-words">{turn.opening}</p>
    </div>
  );
};

const tickTone = (tick: number, pointed: Pointed | null, lit: boolean) => {
  if (pointed?.tick === tick) return "bg-text-strong";

  if (pointed !== null && Math.abs(tick - pointed.tick) <= 2) return "bg-text-subtle";

  return lit ? "bg-text-subtle" : "bg-text-faint";
};

export interface TurnRailProps {
  readonly turns: ReadonlyArray<TurnView>;
  readonly rows: ReadonlyArray<Row>;
  readonly range: RowRange;
  readonly onJump: (turnId: string) => void;
}

export const TurnRail = ({ turns, rows, range, onJump }: TurnRailProps) => {
  const items = useMemo(() => railTurns(turns), [turns]);
  const turnIndex = useMemo(() => new Map(items.map((t, i) => [t.turnId, i])), [items]);
  const inView = useInView(range, rows, turnIndex);
  const track = useRef<HTMLDivElement>(null);
  const room = useRoom(track);
  const [pointed, setPointed] = useState<Pointed | null>(null);
  const layout = railLayout(items.length, room);
  const calm = useSyncExternalStore(subscribeStill, still);

  const point = (turn: number, by: Pointed["by"]) => {
    const clamped = Math.min(items.length - 1, Math.max(0, turn));
    const tick = Math.min(layout.ticks - 1, Math.floor((clamped * layout.ticks) / items.length));

    setPointed((p) => (p?.turn === clamped && p.by === by ? p : { turn: clamped, tick, by }));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();

    point(turnAt(event.clientY - box.top - PAD, layout.height, items.length), "pointer");
  };

  const jump = (turn: number) => {
    const target = items[turn];

    if (target !== undefined) onJump(target.turnId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = pointed?.turn ?? inView.last;

    const moves = new Map([
      ["ArrowUp", at - 1],
      ["ArrowDown", at + 1],
      ["Home", 0],
      ["End", items.length - 1],
    ]);

    const next = moves.get(event.key);

    if (next !== undefined) point(next, "keyboard");
    else if (event.key === "Enter" && pointed !== null) jump(pointed.turn);
    else return;
    event.preventDefault();
  };

  const shown = pointed === null ? undefined : items[pointed.turn];

  return (
    <div
      className="absolute top-1/2 right-2 z-[5] -translate-y-1/2"
      data-testid="turn-rail"
      hidden={room === 0}
    >
      <div
        ref={track}
        role="listbox"
        aria-label="Turns"
        aria-activedescendant={pointed === null ? undefined : `turn-rail-${pointed.tick}`}
        tabIndex={0}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setPointed((p) => (p?.by === "pointer" ? null : p))}
        onClick={() => pointed !== null && jump(pointed.turn)}
        // Only keyboard focus picks a Turn: a click focuses too, and must jump where it points.
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible"))
            point(inView.last === -1 ? items.length - 1 : inView.last, "keyboard");
        }}
        onBlur={() => setPointed(null)}
        onKeyDown={onKeyDown}
        className="rounded-control focus-visible:outline-starlight flex w-8 cursor-default flex-col py-1 pr-1.5 focus-visible:outline-2 focus-visible:-outline-offset-2"
        style={{ height: layout.height + 2 * PAD }}
      >
        {Array.from({ length: layout.ticks }, (_, tick) => {
          const turn = tickTurn(tick, layout.ticks, items.length);
          const lit = turn >= inView.first && turn <= inView.last;

          return (
            <div
              key={tick}
              id={`turn-rail-${tick}`}
              role="option"
              aria-selected={pointed?.tick === tick}
              aria-label={`Turn ${items[turn]?.number ?? turn + 1}`}
              className="flex shrink-0 items-center justify-end"
              style={{ height: layout.pitch }}
            >
              <span
                className={cn(
                  "h-0.5 origin-right rounded-full ease-out",
                  calm ? "transition-none" : "transition-transform duration-[140ms]",
                  tickTone(tick, pointed, lit)
                )}
                style={{
                  width: LONGEST,
                  transform: `scaleX(${tickLength(tick, pointed?.tick ?? null, calm) / LONGEST})`,
                }}
              />
            </div>
          );
        })}
      </div>
      {shown === undefined || pointed === null ? null : (
        <Preview turn={shown} top={PAD + pointed.tick * layout.pitch + layout.pitch / 2} />
      )}
    </div>
  );
};
