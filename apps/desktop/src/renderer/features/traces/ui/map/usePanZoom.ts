/**
 * Drag to pan, scroll to zoom, double-click to fit (DESIGN.md, Traces → Service map). The
 * transform is written straight to the layer, so panning never re-renders the map.
 */
import {
  type KeyboardEvent,
  type PointerEvent,
  type UIEvent,
  useCallback,
  useEffect,
  useRef,
} from "react";
import {
  type Box,
  fitView,
  openView,
  revealView,
  type Size,
  transformOf,
  type Viewport,
  wheelFactor,
  zoomAt,
} from "../../model/map/index.ts";

/** A press that moves less than this is a click on a service, not a pan. */
const DRAG_PX = 3;

const KEY_PAN = 48;

const KEY_ZOOM = 1.25;

interface Drag {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly from: Viewport;
  moved: boolean;
}

export const usePanZoom = (map: Size) => {
  const canvas = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const view = useRef<Viewport>({ x: 0, y: 0, k: 1 });
  const touched = useRef(false);
  const drag = useRef<Drag | null>(null);
  const dragged = useRef(false);

  const show = useCallback((next: Viewport) => {
    view.current = next;

    if (layer.current !== null) layer.current.style.transform = transformOf(next);
  }, []);

  const fit = useCallback(() => {
    const box = canvas.current;

    if (box === null) return;
    touched.current = true;
    show(fitView({ width: box.clientWidth, height: box.clientHeight }, map));
  }, [map, show]);

  const opening = useCallback(() => {
    const box = canvas.current;

    if (box !== null) show(openView({ width: box.clientWidth, height: box.clientHeight }, map));
  }, [map, show]);

  const move = useCallback(
    (next: Viewport) => {
      touched.current = true;
      show(next);
    },
    [show]
  );

  // Opens readable and follows the canvas's and map's size until the user pans, zooms or fits.
  useEffect(() => {
    const box = canvas.current;

    if (box === null) return;

    if (!touched.current) opening();

    const observer = new ResizeObserver(() => {
      if (!touched.current) opening();
    });

    observer.observe(box);

    return () => observer.disconnect();
  }, [opening]);

  // React's wheel listener is passive; zooming has to stop the page scrolling.
  useEffect(() => {
    const box = canvas.current;

    if (box === null) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = box.getBoundingClientRect();

      move(
        zoomAt(view.current, wheelFactor(event.deltaY), {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        })
      );
    };

    box.addEventListener("wheel", onWheel, { passive: false });

    return () => box.removeEventListener("wheel", onWheel);
  }, [move]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragged.current = false;
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      from: view.current,
      moved: false,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;

    if (d === null || d.id !== event.pointerId) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;

    if (!d.moved && Math.hypot(dx, dy) < DRAG_PX) return;

    if (!d.moved) event.currentTarget.setPointerCapture(event.pointerId);
    d.moved = true;
    move({ ...d.from, x: d.from.x + dx, y: d.from.y + dy });
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    dragged.current = drag.current?.moved === true;
    drag.current = null;

    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  // A click ends any press; one from the keyboard or a screen reader never started a drag.
  const onClick = () => {
    dragged.current = false;
  };

  // Focus scrolls even an overflow-hidden box; the map pans instead, so the foot stays put.
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    event.currentTarget.scrollTop = 0;
    event.currentTarget.scrollLeft = 0;
  };

  const reveal = useCallback(
    (target: Box) => {
      const box = canvas.current;

      // A press focuses what it lands on; a pan from there mustn't jump.
      if (box === null || drag.current !== null) return;

      const next = revealView(
        view.current,
        { width: box.clientWidth, height: box.clientHeight },
        target
      );

      if (next.x !== view.current.x || next.y !== view.current.y) move(next);
    },
    [move]
  );

  const centre = () => {
    const box = canvas.current;

    return { x: (box?.clientWidth ?? 0) / 2, y: (box?.clientHeight ?? 0) / 2 };
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const v = view.current;

    const keys = new Map([
      ["=", () => move(zoomAt(v, KEY_ZOOM, centre()))],
      ["+", () => move(zoomAt(v, KEY_ZOOM, centre()))],
      ["-", () => move(zoomAt(v, 1 / KEY_ZOOM, centre()))],
      ["0", fit],
      ["ArrowLeft", () => move({ ...v, x: v.x + KEY_PAN })],
      ["ArrowRight", () => move({ ...v, x: v.x - KEY_PAN })],
      ["ArrowUp", () => move({ ...v, y: v.y + KEY_PAN })],
      ["ArrowDown", () => move({ ...v, y: v.y - KEY_PAN })],
    ]);

    const run = event.target === event.currentTarget ? keys.get(event.key) : undefined;

    if (run === undefined) return;
    event.preventDefault();
    run();
  };

  return {
    canvas,
    layer,
    fit,
    reveal,
    /** True when the press that ended was a pan, so it doesn't select what it ended on. */
    wasDrag: () => dragged.current,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onClick,
      onScroll,
      onDoubleClick: fit,
      onKeyDown,
    },
  };
};
