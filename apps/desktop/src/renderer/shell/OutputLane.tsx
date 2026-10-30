/**
 * The Output lane right of Intent (DESIGN.md, Output): the 240px rail while
 * collapsed, else the panel, resizable from its left edge. Opening slides
 * the panel in from the rail on `transform` only; Reduce Motion makes it instant.
 */
import type { SessionId } from "@polaris/protocol";
import { cn, Panel } from "@polaris/ui";
import { type KeyboardEvent, type PointerEvent, type RefObject, useRef } from "react";
import { slots } from "../app/slots.tsx";
import {
  clampWidth,
  defaultWidth,
  KEY_STEP,
  RAIL_WIDTH,
  setOutputWidth,
  useOutputShown,
  useOutputWidth,
  widthCss,
} from "../features/session/index.ts";
import { TerminalDock } from "../features/terminal/index.ts";
import { useBrowserFeed } from "../features/browser/index.ts";
import { onAgentTab, useShownSubagent } from "../features/session/index.ts";

export interface OutputLaneProps {
  readonly hostKey: string;
  readonly workspaceId: string;
  readonly sessionId: SessionId;
  /** Intent and Output together: the panel's width is measured against it. */
  readonly lane: RefObject<HTMLDivElement | null>;
}

/** True for the render that opens the panel in the same session, until it closes again. */
const useSlideIn = (key: string, shown: boolean) => {
  const last = useRef({ key, shown });
  const sliding = useRef<string | null>(null);

  if (shown && !last.current.shown && last.current.key === key) sliding.current = key;

  if (!shown) sliding.current = null;
  last.current = { key, shown };

  return shown && sliding.current === key;
};

/** The edge is on the panel's left: ← widens it, → narrows it. */
const STEPS = new Map([
  ["ArrowLeft", KEY_STEP],
  ["ArrowRight", -KEY_STEP],
]);

const ResizeEdge = ({ lane }: { readonly lane: RefObject<HTMLDivElement | null> }) => {
  const width = useOutputWidth();

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const box = lane.current?.getBoundingClientRect();

    if (box === undefined) return;
    event.currentTarget.setPointerCapture(event.pointerId);

    const move = (e: globalThis.PointerEvent) =>
      setOutputWidth(clampWidth(box.right - e.clientX, box.width));

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const available = lane.current?.getBoundingClientRect().width;
    const step = STEPS.get(event.key) ?? 0;

    if (available === undefined || step === 0) return;
    event.preventDefault();
    setOutputWidth(clampWidth((width ?? defaultWidth(available)) + step, available));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize output"
      aria-valuenow={width ?? undefined}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => setOutputWidth(null)}
      className="absolute inset-y-0 -left-2 z-10 w-2 cursor-col-resize focus-visible:outline-none"
      data-testid="output-resize"
    />
  );
};

export const OutputLane = ({ hostKey, workspaceId, sessionId, lane }: OutputLaneProps) => {
  const shown = useOutputShown({ hostKey, workspaceId }, sessionId);
  const width = useOutputWidth();
  const slide = useSlideIn(`${hostKey}\u0000${sessionId}`, shown);
  const subagentShown = useShownSubagent(hostKey, sessionId) !== null;

  useBrowserFeed(hostKey, sessionId, () =>
    onAgentTab({ hostKey, workspaceId }, sessionId, subagentShown)
  );

  if (!shown) {
    return (
      <Panel className="mb-2 shrink-0" style={{ width: RAIL_WIDTH }}>
        <TerminalDock hostKey={hostKey} workspaceId={workspaceId} tuckable>
          <slots.OutputRail hostKey={hostKey} sessionId={sessionId} />
        </TerminalDock>
      </Panel>
    );
  }

  return (
    <div className="relative mb-2 flex shrink-0 flex-col" style={{ width: widthCss(width) }}>
      <ResizeEdge lane={lane} />
      <Panel className={cn("flex-1", slide && "output-slide-in")} data-testid="output-panel">
        <TerminalDock hostKey={hostKey} workspaceId={workspaceId} tuckable>
          <slots.SessionOutput hostKey={hostKey} sessionId={sessionId} />
        </TerminalDock>
      </Panel>
    </div>
  );
};
