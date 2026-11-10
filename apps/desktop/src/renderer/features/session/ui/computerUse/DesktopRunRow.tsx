/**
 * A computer use Tool Run (Paper CU5): "Using Simulator · clicking · 2 actions" ending in a
 * thumbnail of the window. Hovering the thumbnail opens the live view; only then does the Host
 * capture. Only the session's latest run has a thumbnail: the Host shows the session's last window.
 */
import {
  ChevronDownIcon,
  ChevronRightIcon,
  cn,
  CursorIcon,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@polaris/ui";
import { useState } from "react";
import { useApp } from "../../../../shell/hooks.ts";
import { sessionKey } from "../../../../store/store.ts";
import { chooseCollapse, initialOpen } from "../../model/collapse.ts";
import { type DesktopRun, runDetail, runTitle } from "../../model/computerUse/index.ts";
import { latestDesktopCallId } from "../../model/computerUse/session.ts";
import type { ItemView } from "../../model/items.ts";
import { type SessionTarget, useSessionTarget } from "../polarisTool/target.ts";
import { LiveView } from "./LiveView.tsx";
import { useLatestThumbnail } from "./usePreview.ts";

export const RunThumbnail = ({
  target,
  run,
}: {
  readonly target: SessionTarget;
  readonly run: DesktopRun;
}) => {
  const [open, setOpen] = useState(false);
  const live = run.running;
  // A still is fetched once per finished action, never per live frame.
  const refresh = `${run.items.at(-1)?.id ?? ""}:${run.running}`;
  const url = useLatestThumbnail({ ...target, refresh }, !live || open);

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={150} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label={`Show ${run.appName ?? "the app"}'s window`}
          data-testid="desktop-thumbnail"
          onClick={() => setOpen(true)}
          className={cn(
            "rounded-control bg-fill-selected flex h-[38px] w-[60px] shrink-0 cursor-default items-center justify-center overflow-hidden",
            live ? "ring-starlight/40 ring-1 ring-inset" : "border-hairline border"
          )}
        >
          {url === null ? (
            <CursorIcon size={12} className="text-text-faint" />
          ) : (
            <img src={url} alt="" decoding="async" className="size-full object-contain" />
          )}
        </button>
      </HoverCardTrigger>
      {/* Content mounts only while open, so the live view subscribes only then. */}
      <HoverCardContent
        side="right"
        align="center"
        data-surface="raised"
        className="bg-raised rounded-card w-[380px] max-w-[calc(100vw-24px)] p-0"
        data-testid="desktop-popover"
      >
        <LiveView hostKey={target.hostKey} sessionId={target.sessionId} run={run} />
      </HoverCardContent>
    </HoverCard>
  );
};

const useLatest = (target: SessionTarget | null, run: DesktopRun) => {
  const latest = useApp((s) =>
    target === null
      ? null
      : latestDesktopCallId(s.sessions[sessionKey(target.hostKey, target.sessionId)])
  );

  return run.items.some((i) => i.id === latest);
};

export interface DesktopRunRowProps {
  readonly id: string;
  readonly run: DesktopRun;
  readonly items: ReadonlyArray<ItemView>;
  /** Renders the run's calls when it is open. */
  readonly renderItem: (item: ItemView) => React.ReactNode;
}

export const DesktopRunRow = ({ id, run, items, renderItem }: DesktopRunRowProps) => {
  const target = useSessionTarget();
  const latest = useLatest(target, run);
  const key = `desktop:${id}`;
  const [open, setOpen] = useState(() => initialOpen(key));

  const toggle = () => {
    chooseCollapse(key, !open);
    setOpen(!open);
  };

  return (
    <div className="flex flex-col" data-testid="desktop-run" data-running={run.running}>
      <div
        className={cn(
          "rounded-row gap-2.5 flex h-11 min-w-0 items-center px-2",
          run.running && "bg-fill-hover"
        )}
      >
        <CursorIcon
          size={14}
          className={cn("shrink-0", run.running ? "text-starlight" : "text-text-subtle")}
        />
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="flex min-w-0 flex-1 cursor-default items-baseline gap-1.5 text-left"
        >
          <span className="text-body text-text-strong shrink-0">{runTitle(run)}</span>
          <span className="text-caption text-text-subtle truncate">{runDetail(run)}</span>
          <span className="self-center">
            {open ? (
              <ChevronDownIcon size={10} className="text-text-faint" />
            ) : (
              <ChevronRightIcon size={10} className="text-text-faint" />
            )}
          </span>
        </button>
        {target !== null && latest ? <RunThumbnail target={target} run={run} /> : null}
      </div>
      {open ? (
        <div className="border-hairline mt-1 ml-1.5 flex flex-col gap-1.5 border-l pl-3.5">
          {items.map((item) => (
            <div key={item.id}>{renderItem(item)}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
};
