/**
 * The user's pointer, wheel and keys on the stream, as native listeners: pointer moves are
 * coalesced to one per animation frame, and nothing here renders.
 */
import type { SimulatorConnection } from "./connection.ts";
import {
  type QuarterTurns,
  type Rect,
  type ScreenPoint,
  toFramePoint,
  toScreenPoint,
  toScreenPointClamped,
} from "./geometry.ts";
import { scrollOf, touchTracker, type TouchMessage } from "./gesture.ts";
import { androidKeycode, appShortcut, hidUsage } from "./keys.ts";

interface InputTarget {
  /** The element that takes focus and the pointer: the stream's area. */
  readonly element: HTMLElement;
  /** The screen's rect as shown, in client pixels now. */
  readonly screen: () => Rect;
  /** The quarter turns the frame is shown at: input maps back through them. */
  readonly turns: () => QuarterTurns;
  readonly connection: () => SimulatorConnection | null;
}

export const attachInput = ({ element, screen, turns, connection }: InputTarget) => {
  const frame = (shown: ScreenPoint) => toFramePoint(shown, turns());
  const touch = touchTracker();
  let pointerId: number | null = null;
  let pendingMove: PointerEvent | null = null;
  let moveFrame = 0;
  let wheel = { x: 0, y: 0, at: { x: 0.5, y: 0.5 } };
  let wheelFrame = 0;
  const held = new Set<string>();

  const send = (messages: ReadonlyArray<TouchMessage>) => {
    for (const message of messages)
      connection()?.touch(message.type, message.x, message.y, message.at);
  };

  const pointer = (event: PointerEvent) => ({
    point: frame(toScreenPointClamped({ x: event.clientX, y: event.clientY }, screen())),
    client: { x: event.clientX, y: event.clientY },
  });

  const flushMove = () => {
    moveFrame = 0;

    if (pendingMove === null) return;
    const event = pendingMove;

    pendingMove = null;
    send(touch.move(pointer(event), event.timeStamp));
  };

  const onDown = (event: PointerEvent) => {
    if (event.button !== 0 || pointerId !== null) return;
    const point = toScreenPoint({ x: event.clientX, y: event.clientY }, screen());

    element.focus({ preventScroll: true });

    if (point === null) return;
    event.preventDefault();
    pointerId = event.pointerId;
    element.setPointerCapture(event.pointerId);
    send(
      touch.down(
        { point: frame(point), client: { x: event.clientX, y: event.clientY } },
        event.timeStamp
      )
    );
  };

  const onMove = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    pendingMove = event;

    if (moveFrame === 0) moveFrame = requestAnimationFrame(flushMove);
  };

  const onUp = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    cancelAnimationFrame(moveFrame);
    flushMove();
    pointerId = null;
    send(touch.up(pointer(event), event.timeStamp));
  };

  const onLost = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    cancelAnimationFrame(moveFrame);
    moveFrame = 0;
    pendingMove = null;
    pointerId = null;
    send(touch.cancel(event.timeStamp));
  };

  const flushWheel = () => {
    wheelFrame = 0;
    const shown = scrollOf(wheel, screen(), wheel.at);

    wheel = { x: 0, y: 0, at: wheel.at };

    if (shown === null) return;
    // The scroll's point and direction, turned back into the frame like a touch.
    const at = frame({ x: shown.x, y: shown.y });
    const ahead = frame({ x: shown.x + shown.dx, y: shown.y + shown.dy });

    connection()?.scroll({ x: at.x, y: at.y, dx: ahead.x - at.x, dy: ahead.y - at.y });
  };

  const onWheel = (event: WheelEvent) => {
    const at = toScreenPoint({ x: event.clientX, y: event.clientY }, screen());

    if (at === null) return;
    event.preventDefault();
    // Line and page deltas (a mouse wheel) as pixels, roughly a line's height.
    const unit = [1, 16][event.deltaMode] ?? screen().height;

    wheel = { x: wheel.x + event.deltaX * unit, y: wheel.y + event.deltaY * unit, at };

    if (wheelFrame === 0) wheelFrame = requestAnimationFrame(flushWheel);
  };

  const keyCode = (event: KeyboardEvent) => ({
    usage: hidUsage(event.code),
    key: event.key,
    android: androidKeycode(event.code),
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (appShortcut(event) || event.isComposing) return;
    event.preventDefault();

    // The Simulator repeats a held key itself.
    if (event.repeat) return;
    held.add(event.code);
    connection()?.key("down", keyCode(event));
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (!held.delete(event.code)) return;
    event.preventDefault();
    connection()?.key("up", keyCode(event));
  };

  /** Focus left with keys down: they come up, or the Simulator would repeat them forever. */
  const onBlur = () => {
    for (const code of held)
      connection()?.key("up", { usage: hidUsage(code), key: "", android: androidKeycode(code) });
    held.clear();
  };

  const abort = new AbortController();
  const options = { signal: abort.signal };

  element.addEventListener("pointerdown", onDown, options);
  element.addEventListener("pointermove", onMove, options);
  element.addEventListener("pointerup", onUp, options);
  element.addEventListener("pointercancel", onLost, options);
  element.addEventListener("lostpointercapture", onLost, options);
  element.addEventListener("keydown", onKeyDown, options);
  element.addEventListener("keyup", onKeyUp, options);
  element.addEventListener("blur", onBlur, options);
  element.addEventListener("wheel", onWheel, { ...options, passive: false });

  return () => {
    cancelAnimationFrame(moveFrame);
    cancelAnimationFrame(wheelFrame);
    onBlur();
    abort.abort();
  };
};
