/**
 * The live view of a session's window (Paper CU5; DESIGN.md, Computer use): the controlled
 * app's window, never the whole screen, in the transcript's hover popover and the sidebar peek.
 * Live in Starlight; last frame, in use and screen locked are neutral.
 */
import { harnessEntry, type SessionId } from "@polaris/protocol";
import { cn, LockIcon } from "@polaris/ui";
import type { ReactNode } from "react";
import { useComputerUseFeed } from "../../../computer-use/hooks.ts";
import { platformOf } from "../../../machines/restart/model.ts";
import { useNow } from "../../../../shell/useNow.ts";
import { useApp, useShellActions } from "../../../../shell/hooks.ts";
import { useHost } from "../../hooks.ts";
import {
  type DesktopRun,
  frameAge,
  idleLine,
  type LiveState,
  liveState,
  stateFooter,
  stateKicker,
} from "../../model/computerUse/index.ts";
import { type PreviewStatus, useSessionPreview } from "./usePreview.ts";

/** The view's longer side in device pixels: the popover's well at 2× (D4 clamps to 1280). */
const VIEW_EDGE = 720;

const Kicker = ({ state, text }: { readonly state: LiveState; readonly text: string }) => (
  <span
    className={cn(
      "flex shrink-0 items-center gap-1.5 font-mono text-[10px] leading-3 tracking-[0.06em]",
      state.kind === "live" ? "text-starlight-text" : "text-text-subtle"
    )}
    data-testid="live-view-kicker"
  >
    {state.kind === "live" ? <span className="bg-starlight size-1.5 shrink-0" /> : null}
    {text}
  </span>
);

/** The holder of an app, from the Host feed, only while a refusal needs it. */
const useHolder = (hostKey: string, run: DesktopRun): SessionId | null => {
  const feed = useComputerUseFeed(run.failure?.kind === "failed" ? hostKey : null);
  const appId = run.app?.id ?? null;

  return feed.controlled.find((c) => c.app.id === appId)?.sessionId ?? null;
};

const useSessionTitle = (hostKey: string, sessionId: SessionId | null) =>
  useApp((s) => {
    const entry = sessionId === null ? undefined : s.hostModels[hostKey]?.sessions.get(sessionId);

    return entry === undefined ? null : entry.session.title || "Untitled session";
  });

const InUseBody = ({ title }: { readonly title: string }) => (
  <div className="flex flex-col items-center gap-2">
    <span className="rounded-row bg-fill-selected h-[120px] w-[70px]" />
    <span className="text-caption text-text-default">In use by {title}</span>
  </div>
);

const Picture = ({
  canvas,
  status,
  painted,
  host,
  locked,
}: {
  readonly canvas: (element: HTMLCanvasElement | null) => void;
  readonly status: PreviewStatus;
  readonly painted: boolean;
  readonly host: string;
  readonly locked: boolean;
}) => {
  const idle = status.kind === "idle" ? idleLine(status.reason, host) : null;
  const empty = status.kind === "empty" ? "No frame yet" : null;
  const note = idle ?? empty;

  return (
    <div className="flex min-h-0 flex-col items-center gap-2">
      <canvas
        ref={canvas}
        data-testid="live-view-canvas"
        className={cn(
          "rounded-control max-h-[300px] max-w-full object-contain",
          !painted && "hidden"
        )}
      />
      {note === null ? null : <span className="text-caption text-text-subtle">{note}</span>}
      {locked ? (
        <span className="bg-raised border-hairline text-text-subtle flex h-[22px] items-center gap-1.5 rounded-full border px-2 text-[11px] leading-[14px]">
          <LockIcon size={10} />
          Screen locked
        </span>
      ) : null}
    </div>
  );
};

export interface LiveViewProps {
  readonly hostKey: string;
  readonly sessionId: SessionId;
  readonly run: DesktopRun;
  /** The card's title: the app in the transcript, the session in the peek. */
  readonly title?: string;
  /** Under a live picture; the state's own line when absent, and in every other state. */
  readonly liveFooter?: string;
}

/** Mounted only while open: mounting subscribes to the session's frames, unmounting ends it. */
export const LiveView = ({ hostKey, sessionId, run, title, liveFooter }: LiveViewProps) => {
  const host = useHost(hostKey);
  const now = useNow();
  const { selectSession } = useShellActions();
  const holder = useHolder(hostKey, run);
  const holderTitle = useSessionTitle(hostKey, holder);

  const harness = useApp(
    (s) => s.hostModels[hostKey]?.sessions.get(sessionId)?.session.harness ?? null
  );

  const refresh = `${run.items.at(-1)?.id ?? ""}:${run.running}`;
  const preview = useSessionPreview({ hostKey, sessionId, maxEdgePx: VIEW_EDGE, refresh }, true);
  const hostName = host?.label ?? "this host";

  const state = liveState({
    failure: run.failure,
    holder,
    sessionId,
    hostLive: preview.live !== false,
    idle: preview.status.kind === "idle" ? preview.status.reason : null,
  });

  const capturedAt = preview.capturedAt;

  const line =
    state.kind === "live" && liveFooter !== undefined
      ? liveFooter
      : stateFooter(state, {
          harness: harness === null ? "The agent" : (harnessEntry(harness)?.name ?? harness),
          host: hostName,
          platform: platformOf(host?.status.host?.platform),
          run,
        });

  const windowTitle = preview.status.kind === "frames" ? preview.status.window?.title : null;

  // The peek is titled with the session alone (Paper CU5).
  const subtitle =
    title === undefined
      ? [windowTitle ?? null, hostName].filter((part) => part !== null && part !== "").join(" · ")
      : "";

  let action: ReactNode = null;

  if (state.kind === "in-use" && holder !== null && holderTitle !== null)
    action = (
      <button
        type="button"
        className="text-caption text-text-strong hover:text-text-default shrink-0 cursor-default"
        onClick={() => selectSession({ hostKey, sessionId: holder })}
      >
        Open {holderTitle}
      </button>
    );

  return (
    <div className="flex flex-col gap-2 px-2 pb-2" data-testid="live-view" data-state={state.kind}>
      <div className="flex items-center justify-between gap-2 px-2 pt-3 pb-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-body text-text-strong shrink-0 font-medium">
            {title ?? run.appName ?? "An app"}
          </span>
          <span className="text-caption text-text-subtle truncate">{subtitle}</span>
        </div>
        <Kicker state={state} text={stateKicker(state, frameAge(capturedAt, now))} />
      </div>
      <div className="rounded-row border-hairline bg-well flex min-h-[120px] items-center justify-center border p-3.5">
        {state.kind === "in-use" ? (
          <InUseBody title={holderTitle ?? "another session"} />
        ) : (
          <Picture
            canvas={preview.canvas}
            status={preview.status}
            painted={preview.painted}
            host={hostName}
            locked={state.kind === "locked"}
          />
        )}
      </div>
      <div className="flex min-h-7 items-center justify-between gap-3 px-2">
        <span className="text-caption text-text-subtle min-w-0 truncate">{line}</span>
        {action}
      </div>
    </div>
  );
};
