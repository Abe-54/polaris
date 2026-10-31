/**
 * The minimap (DESIGN.md, Traces → Waterfall; Paper T1): every span of the trace drawn on one
 * canvas, lane by depth, with a draggable window that sets the waterfall's time range. Drag the
 * window to pan, its edges to resize, elsewhere to draw a new one; double-click shows it all.
 */
import { cn } from "@polaris/ui";
import { type PointerEvent, useEffect, useRef } from "react";
import { useApp } from "../../../../shell/hooks.ts";
import { ERROR_HUE, serviceHue, type TraceTimes } from "../../model/waterfall/index.ts";
import type { TimeWindow } from "./useTraceView.ts";

const HEIGHT = 36;

const LANE = 3;

const LANE_GAP = 1;

const PAD = 4;

const LANES = Math.floor((HEIGHT - 2 * PAD + LANE_GAP) / (LANE + LANE_GAP));

/** A CSS colour (custom properties, light-dark()) as the canvas can paint it. */
const resolve = (probe: HTMLElement, colour: string) => {
  probe.style.color = colour;

  return getComputedStyle(probe).color;
};

const draw = (canvas: HTMLCanvasElement, probe: HTMLElement, times: TraceTimes) => {
  const ratio = window.devicePixelRatio || 1;
  const { width } = canvas.getBoundingClientRect();
  const context = canvas.getContext("2d");

  if (context === null || width === 0) return;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(HEIGHT * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, HEIGHT);

  const hues = new Map(
    times.services.map((s) => [s.name, resolve(probe, serviceHue(s.index))] as const)
  );

  const error = resolve(probe, ERROR_HUE);
  const scale = width / Math.max(times.end, 0.001);

  context.globalAlpha = 0.65;

  for (const s of times.spans) {
    context.fillStyle = s.span.status === "error" ? error : (hues.get(s.span.service) ?? error);
    context.fillRect(
      s.start * scale,
      PAD + Math.min(s.depth, LANES - 1) * (LANE + LANE_GAP),
      Math.max(1, (s.end - s.start) * scale),
      LANE
    );
  }
};

type Drag =
  | { readonly kind: "pan"; readonly at: number; readonly start: TimeWindow }
  | { readonly kind: "from" | "to" | "new"; readonly at: number };

const MIN_SHARE = 0.005;

export const Minimap = ({
  times,
  range,
  onRange,
}: {
  readonly times: TraceTimes;
  readonly range: TimeWindow;
  readonly onRange: (next: TimeWindow | null) => void;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const theme = useApp((s) => s.theme);
  const total = Math.max(times.end, 0.001);

  useEffect(() => {
    const element = canvas.current;
    const hidden = probe.current;

    if (element === null || hidden === null) return undefined;
    const paint = () => draw(element, hidden, times);
    const observer = new ResizeObserver(paint);

    paint();
    observer.observe(element);

    return () => observer.disconnect();
  }, [times, theme]);

  const msAt = (event: PointerEvent) => {
    const rect = box.current?.getBoundingClientRect();

    if (rect === undefined || rect.width === 0) return 0;

    return Math.min(total, Math.max(0, ((event.clientX - rect.left) / rect.width) * total));
  };

  const set = (a: number, b: number) => {
    const from = Math.max(0, Math.min(a, b));
    const to = Math.min(total, Math.max(from + total * MIN_SHARE, Math.max(a, b)));

    onRange({ from, to });
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const at = msAt(event);
    const edge = event.target instanceof HTMLElement ? event.target.dataset["edge"] : undefined;

    event.currentTarget.setPointerCapture(event.pointerId);

    if (edge === "from" || edge === "to") drag.current = { kind: edge, at };
    else if (at >= range.from && at <= range.to && range.to - range.from < total)
      drag.current = { kind: "pan", at, start: range };
    else drag.current = { kind: "new", at };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;

    if (current === null) return;
    const at = msAt(event);

    if (current.kind === "pan") {
      const length = current.start.to - current.start.from;
      const from = Math.min(total - length, Math.max(0, current.start.from + at - current.at));

      onRange({ from, to: from + length });
    } else if (current.kind === "from") set(at, range.to);
    else if (current.kind === "to") set(range.from, at);
    else if (Math.abs(at - current.at) > total * MIN_SHARE) set(current.at, at);
  };

  const left = range.from / total;
  const right = range.to / total;
  const whole = left <= 0 && right >= 1;

  return (
    <div
      ref={box}
      data-testid="waterfall-minimap"
      role="slider"
      aria-label="Shown part of the trace"
      aria-valuemin={0}
      aria-valuemax={Math.round(total)}
      aria-valuenow={Math.round(range.from)}
      aria-valuetext={
        whole ? "The whole trace" : `${Math.round(range.from)} to ${Math.round(range.to)} ms`
      }
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => {
        drag.current = null;
      }}
      onDoubleClick={() => onRange(null)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !whole) {
          event.stopPropagation();
          onRange(null);
        }
      }}
      className="bg-well ring-hairline focus-visible:ring-starlight rounded-control relative mr-3 mb-1.5 ml-4 h-9 shrink-0 cursor-default touch-none overflow-hidden ring-1 outline-none ring-inset focus-visible:ring-2"
    >
      <span ref={probe} aria-hidden className="invisible absolute" />
      <canvas ref={canvas} className="pointer-events-none absolute inset-0 h-9 w-full" />
      <div
        className="bg-panel/60 pointer-events-none absolute inset-y-0 left-0"
        style={{ width: `${left * 100}%` }}
      />
      <div
        className="bg-panel/60 pointer-events-none absolute inset-y-0 right-0"
        style={{ width: `${(1 - right) * 100}%` }}
      />
      <div
        className={cn(
          "ring-text-subtle/40 absolute inset-y-0 rounded-control ring-1 ring-inset",
          whole && "ring-transparent"
        )}
        style={{ left: `${left * 100}%`, width: `${(right - left) * 100}%` }}
      >
        <span
          data-edge="from"
          className="bg-text-subtle absolute top-2.5 left-0.5 h-4 w-[3px] cursor-ew-resize rounded-[2px]"
        />
        <span
          data-edge="to"
          className="bg-text-subtle absolute top-2.5 right-0.5 h-4 w-[3px] cursor-ew-resize rounded-[2px]"
        />
      </div>
    </div>
  );
};
