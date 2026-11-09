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
  /** The frame on screen as a PNG, turned upright; null before one paints. */
  readonly snapshot: () => Promise<Blob | null>;
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
  /** Draws the frame in a device bezel this many px wide, inside the area. */
  readonly bezel?: number;
  readonly ref?: Ref<SimulatorStreamHandle>;
}

const EMPTY: Rect = { left: 0, top: 0, width: 0, height: 0 };

/** The canvas's frame as a PNG, turned as the screen shows it. */
const uprightPng = (source: HTMLCanvasElement | null, turns: QuarterTurns) =>
  new Promise<Blob | null>((resolve) => {
    if (source === null || source.width === 0 || source.height === 0) return resolve(null);
    const sideways = turns % 2 === 1;
    const out = document.createElement("canvas");

    out.width = sideways ? source.height : source.width;
    out.height = sideways ? source.width : source.height;
    const context = out.getContext("2d");

    if (context === null) return resolve(null);
    context.translate(out.width / 2, out.height / 2);
    context.rotate((turns * Math.PI) / 2);
    context.drawImage(source, -source.width / 2, -source.height / 2);
    out.toBlob(resolve, "image/png");
  });

export function SimulatorStream({
  target,
  transport,
  label,
  onStatus,
  preferMjpeg,
  bezel = 0,
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
  const inset = useRef(bezel);

  inset.current = bezel;

  /** Places the canvas, turned upright, over the fitted rect; no render. */
  const layout = () => {
    const element = area.current;
    const surface = canvas.current;

    if (element === null || surface === null || screen.current === null) return;
    const shown = turnedSize(screen.current, turns.current);
    const pad = inset.current;
    const room = { width: element.clientWidth - pad * 2, height: element.clientHeight - pad * 2 };
    const inner = fitRect(room, shown);
    const rect = { ...inner, left: inner.left + pad, top: inner.top + pad };
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
      snapshot: () => uprightPng(canvas.current, turns.current),
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
        style={
          bezel > 0
            ? {
                borderRadius: bezel * 3,
                boxShadow: `0 0 0 ${bezel}px var(--simulator-bezel), 0 0 0 ${bezel + 1}px var(--color-hairline)`,
              }
            : undefined
        }
        data-dim={phase === "reconnecting" || phase === "failed"}
      />
    </div>
  );
}
