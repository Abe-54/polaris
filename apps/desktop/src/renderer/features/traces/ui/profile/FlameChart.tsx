/**
 * The flame chart (DESIGN.md, Traces → Profile; Paper T2) on one canvas, redrawn on the next
 * animation frame after any change. Click selects a frame; double-click or Enter opens its
 * file:line in the Editor. ⌘/Ctrl-scroll or a pinch zooms, sideways scroll or a drag pans,
 * scroll moves through deep stacks; arrows walk the tree, Escape clears, 0 shows it all.
 */
import type { ProfileDetail } from "@polaris/protocol";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { useThemeType } from "../../../diffs/useThemeType.ts";
import {
  type FlameLayout,
  type FlameWindow,
  firstRootIn,
  frameAt,
  frameMove,
  panned,
  revealed,
  zoomed,
} from "../../model/profile/flame.ts";
import type { MsRange } from "../../model/profile/overlap.ts";
import { drawFlame, LEVEL, MARK_STRIP, type Palette, paletteOf } from "./flameDraw.ts";

/** Levels shown at once; deeper stacks scroll. */
export const FLAME_ROWS = 6;

const HEIGHT = MARK_STRIP + FLAME_ROWS * LEVEL - 2;

const DRAG_PX = 3;

const ARROWS = new Map<string, "up" | "down" | "left" | "right">([
  ["ArrowUp", "up"],
  ["ArrowDown", "down"],
  ["ArrowLeft", "left"],
  ["ArrowRight", "right"],
]);

export interface FlameChartProps {
  readonly detail: ProfileDetail;
  readonly layout: FlameLayout;
  readonly window: FlameWindow;
  /** The whole recording's length in ms: what zoom and pan stay inside. */
  readonly total: number;
  readonly frame: number | null;
  readonly mark: MsRange | null;
  readonly checkout: string | null;
  readonly onFrame: (node: number | null) => void;
  readonly onOpen: (node: number) => void;
  readonly onWindow: (window: FlameWindow | null) => void;
}

type Drag = { readonly x: number; readonly start: FlameWindow; moved: boolean };

/** Paints on the next animation frame whatever the latest props are; one paint per frame. */
const usePaint = (
  canvas: React.RefObject<HTMLCanvasElement | null>,
  probe: React.RefObject<HTMLSpanElement | null>,
  props: FlameChartProps,
  top: number
) => {
  // The System theme follows macOS, so the resolved colours change without the setting.
  const theme = useThemeType();
  const palette = useRef<Palette | null>(null);
  const latest = useRef({ props, top });
  const pending = useRef<number | null>(null);

  latest.current = { props, top };

  const paint = useRef(() => {
    pending.current = null;
    const element = canvas.current;
    const hidden = probe.current;

    if (element === null || hidden === null) return;
    palette.current ??= paletteOf(hidden);
    const { props: p, top: t } = latest.current;
    const started = performance.now();
    const drawn = drawFlame(element, palette.current, { ...p, top: t, rows: FLAME_ROWS });

    element.dataset["drawMs"] = (performance.now() - started).toFixed(2);
    element.dataset["drawn"] = String(drawn);
  });

  const schedule = () => {
    pending.current ??= requestAnimationFrame(paint.current);
  };

  useEffect(() => {
    palette.current = null;
  }, [theme]);

  useEffect(schedule);

  useEffect(() => {
    const element = canvas.current;

    if (element === null) return undefined;
    const observer = new ResizeObserver(() => schedule());

    observer.observe(element);

    return () => {
      observer.disconnect();

      if (pending.current !== null) cancelAnimationFrame(pending.current);
      pending.current = null;
    };
  }, [canvas]);
};

const msAt = (element: HTMLElement, clientX: number, window: FlameWindow) => {
  const rect = element.getBoundingClientRect();

  return (
    window.from + ((clientX - rect.left) / Math.max(rect.width, 1)) * (window.to - window.from)
  );
};

const levelAt = (element: HTMLElement, clientY: number, top: number) => {
  const y = clientY - element.getBoundingClientRect().top - MARK_STRIP;

  return y < 0 || y % LEVEL >= LEVEL - 2 ? null : top + Math.floor(y / LEVEL);
};

const useWheel = (
  box: React.RefObject<HTMLDivElement | null>,
  props: FlameChartProps,
  setTop: (change: (top: number) => number) => void
) => {
  const latest = useRef(props);

  latest.current = props;

  useEffect(() => {
    const element = box.current;

    if (element === null) return undefined;

    const onWheel = (event: WheelEvent) => {
      const { window, layout, total, onWindow } = latest.current;

      event.preventDefault();

      if (event.ctrlKey || event.metaKey) {
        onWindow(
          zoomed(window, Math.exp(event.deltaY * 0.01), msAt(element, event.clientX, window), total)
        );
      } else if (Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey) {
        const px = event.shiftKey ? event.deltaY : event.deltaX;
        const ms = (px / Math.max(element.clientWidth, 1)) * (window.to - window.from);

        onWindow(panned(window, ms, total));
      } else {
        const most = Math.max(0, layout.levels - FLAME_ROWS);

        setTop((top) => Math.min(most, Math.max(0, top + Math.sign(event.deltaY))));
      }
    };

    element.addEventListener("wheel", onWheel, { passive: false });

    return () => element.removeEventListener("wheel", onWheel);
  }, [box, setTop]);
};

/** +, − and 0 zoom around the middle or show it all; false for other keys. */
const zoomKey = (key: string, props: FlameChartProps): boolean => {
  const { total, window, onWindow } = props;
  const centre = (window.from + window.to) / 2;

  const factor = new Map([
    ["+", 0.5],
    ["=", 0.5],
    ["-", 2],
  ]).get(key);

  if (factor !== undefined) onWindow(zoomed(window, factor, centre, total));
  else if (key === "0") onWindow(null);

  return factor !== undefined || key === "0";
};

/** Arrows walk the tree; a frame reached outside the shown range pans it into view. */
const arrowKey = (arrow: "up" | "down" | "left" | "right", props: FlameChartProps) => {
  const { layout, frame, window, total, onFrame, onWindow } = props;
  const next = frame === null ? firstRootIn(layout, window) : frameMove(layout, frame, arrow);

  if (next === null) return;
  onFrame(next);
  const shown = revealed(layout, window, next, total);

  if (shown !== window) onWindow(shown);
};

/** Arrows walk the tree, Enter opens, Escape clears the frame then the zoom. */
const onKey = (event: KeyboardEvent<HTMLDivElement>, props: FlameChartProps) => {
  const { frame, window, total, onFrame, onOpen, onWindow } = props;
  const zoomedIn = window.from > 0 || window.to < total;
  const arrow = ARROWS.get(event.key);

  if (arrow !== undefined) arrowKey(arrow, props);
  else if (event.key === "Enter" && frame !== null) onOpen(frame);
  else if (event.key === "Escape" && (frame !== null || zoomedIn)) {
    event.stopPropagation();

    if (frame === null) onWindow(null);
    else onFrame(null);
  } else if (!zoomKey(event.key, props)) return;
  event.preventDefault();
};

export const FlameChart = (props: FlameChartProps) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [top, setTop] = useState(0);
  const { layout, window, total, frame, onFrame, onOpen, onWindow } = props;

  usePaint(canvas, probe, props, top);
  useWheel(box, props, setTop);

  // A selected frame below or above the shown levels scrolls into view.
  useEffect(() => {
    if (frame === null) return;
    const level = layout.depth[layout.positionOf[frame] ?? 0] ?? 0;

    setTop((t) => (level < t ? level : level >= t + FLAME_ROWS ? level - FLAME_ROWS + 1 : t));
  }, [frame, layout]);

  const hit = (event: { clientX: number; clientY: number }) => {
    const element = box.current;
    const level = element === null ? null : levelAt(element, event.clientY, top);

    return element === null || level === null
      ? null
      : frameAt(layout, msAt(element, event.clientX, window), level);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, start: window, moved: false };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;

    if (current === null || (!current.moved && Math.abs(event.clientX - current.x) < DRAG_PX))
      return;
    current.moved = true;
    const width = Math.max(event.currentTarget.clientWidth, 1);
    const ms = ((current.x - event.clientX) / width) * (current.start.to - current.start.from);

    onWindow(panned(current.start, ms, total));
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;

    drag.current = null;

    if (current !== null && !current.moved) onFrame(hit(event));
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const node = hit(event);

    if (node === null) onWindow(null);
    else onOpen(node);
  };

  return (
    <div
      ref={box}
      role="application"
      aria-label="Flame chart"
      aria-roledescription="flame chart"
      tabIndex={0}
      data-testid="flame-chart"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onDoubleClick}
      onKeyDown={(event) => onKey(event, props)}
      className="focus-visible:ring-starlight rounded-control relative min-w-0 flex-1 cursor-default touch-none outline-none focus-visible:ring-2"
      style={{ height: HEIGHT }}
    >
      <span ref={probe} aria-hidden className="invisible absolute font-mono" />
      <canvas ref={canvas} className="pointer-events-none absolute inset-0 size-full" />
    </div>
  );
};
