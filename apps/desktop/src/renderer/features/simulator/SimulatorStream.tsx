/**
 * A Simulator's live screen with the user's input (ENG-829): the frame scaled to fit its area,
 * centred, at its own aspect. Frames paint on the canvas directly; React renders on status only.
 */
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { connectSimulator, type SimulatorConnection, type SimulatorStatus } from "./connection.ts";
import { fitRect, type QuarterTurns, type Rect, turnedSize, turnsFor } from "./geometry.ts";
import { attachInput } from "./input.ts";
import type { HardwareButton } from "./protocol.ts";
import type { HubTarget, SimulatorTransport } from "./transport.ts";

export interface SimulatorStreamHandle {
  /** Drops the stream and input socket and opens them again. */
  readonly reconnect: () => void;
  readonly press: (button: HardwareButton) => void;
  /** A quarter turn left (iOS). */
  readonly rotate: () => void;
  readonly focus: () => void;
}

export interface SimulatorStreamProps {
  /** From `simulator.attach`'s latest `Attached`: a new port or token reconnects. */
  readonly target: HubTarget;
  readonly transport: SimulatorTransport;
  /** The device, for assistive technology: "iPhone 17 Pro". */
  readonly label: string;
  readonly onStatus?: (status: SimulatorStatus) => void;
  /** Skip WebCodecs and stream MJPEG (a local Host only; for checks). */
  readonly preferMjpeg?: boolean;
  readonly ref?: Ref<SimulatorStreamHandle>;
}

const EMPTY: Rect = { left: 0, top: 0, width: 0, height: 0 };

export function SimulatorStream({
  target,
  transport,
  label,
  onStatus,
  preferMjpeg,
  ref,
}: SimulatorStreamProps) {
  const area = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const connection = useRef<SimulatorConnection | null>(null);
  const fitted = useRef<Rect>(EMPTY);
  const screen = useRef<{ width: number; height: number } | null>(null);
  const turns = useRef<QuarterTurns>(0);
  const reported = useRef(onStatus);
  const [phase, setPhase] = useState<SimulatorStatus["phase"]>("connecting");

  reported.current = onStatus;

  /** Places the canvas, turned upright, over the fitted rect; no render. */
  const layout = () => {
    const element = area.current;
    const surface = canvas.current;

    if (element === null || surface === null || screen.current === null) return;
    const shown = turnedSize(screen.current, turns.current);
    const rect = fitRect({ width: element.clientWidth, height: element.clientHeight }, shown);
    const sideways = turns.current % 2 === 1;

    fitted.current = rect;
    // From its centre: the canvas keeps the frame's own proportions and turns into the rect.
    surface.style.width = `${sideways ? rect.height : rect.width}px`;
    surface.style.height = `${sideways ? rect.width : rect.height}px`;
    surface.style.transform = `translate(${rect.left + rect.width / 2}px, ${rect.top + rect.height / 2}px) rotate(${turns.current * 90}deg) translate(-50%, -50%)`;
  };

  useEffect(() => {
    const element = area.current;

    if (element === null) return;
    const observer = new ResizeObserver(layout);

    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  const { port, token, id, platform } = target;

  useEffect(() => {
    const surface = canvas.current;

    if (surface === null) return;
    setPhase("connecting");

    const live = connectSimulator({
      transport,
      target: { port, token, id, platform },
      canvas: surface,
      preferMjpeg: preferMjpeg === true,
      status: (status) => {
        const nextTurns = turnsFor(status.orientation);

        if (status.screen !== screen.current || nextTurns !== turns.current) {
          screen.current = status.screen;
          turns.current = nextTurns;
          layout();
        }

        setPhase(status.phase);
        reported.current?.(status);
      },
    });

    connection.current = live;

    return () => {
      live.dispose();
      connection.current = null;
    };
  }, [transport, port, token, id, platform, preferMjpeg]);

  useEffect(() => {
    const element = area.current;

    if (element === null) return;

    return attachInput({
      element,
      connection: () => connection.current,
      turns: () => turns.current,
      screen: () => {
        const box = element.getBoundingClientRect();
        const rect = fitted.current;

        return { ...rect, left: box.left + rect.left, top: box.top + rect.top };
      },
    });
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      reconnect: () => connection.current?.reconnect(),
      press: (button) => connection.current?.button(button),
      rotate: () => connection.current?.rotate(),
      focus: () => area.current?.focus({ preventScroll: true }),
    }),
    []
  );

  return (
    <div
      ref={area}
      role="application"
      aria-label={label}
      aria-busy={phase !== "live"}
      tabIndex={0}
      className="focus-visible:outline-starlight relative h-full w-full touch-none overflow-hidden outline-none select-none focus-visible:outline-2 focus-visible:-outline-offset-2"
    >
      <canvas
        ref={canvas}
        className="absolute top-0 left-0 origin-top-left transition-opacity duration-150 data-[dim=true]:opacity-45"
        data-dim={phase === "reconnecting" || phase === "failed"}
      />
    </div>
  );
}
