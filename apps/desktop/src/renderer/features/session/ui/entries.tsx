/**
 * An agent row's content (`model/runs.ts`): one item, a folded tool run that
 * opens to its calls, or a Subagent where the Turn spawned it. A Subagent is
 * one row showing what it is doing while it works; it opens to its task, its
 * own transcript, grouped the same way, and its final report.
 */
import { CheckIcon, cn, DisclosureChevron, PixelFailedIcon } from "@polaris/ui";
import { useState } from "react";
import { chooseCollapse, initialOpen } from "../model/collapse.ts";
import { formatElapsed } from "../model/format.ts";
import type { Entry } from "../model/runs.ts";
import type { SubagentCard } from "../model/subagents.ts";
import { useElapsed } from "../hooks.ts";
import { type Hue, Item, LiveMark, WELL } from "./items.tsx";
import { DesktopRunRow } from "./computerUse/DesktopRunRow.tsx";
import { Markdown } from "./markdown/index.tsx";
import { SourcesPill } from "./sources.tsx";

/** Open or closed, remembered per row across the virtualized list's unmounts. */
const useOpen = (key: string) => {
  const [open, setOpen] = useState(() => initialOpen(key));

  const toggle = () => {
    chooseCollapse(key, !open);
    setOpen(!open);
  };

  return [open, toggle] as const;
};

const Chevron = ({ open }: { readonly open: boolean }) => (
  <DisclosureChevron open={open} className="text-text-faint" />
);

export interface EntryContext {
  readonly hue: Hue;
  readonly onOpenDiff: () => void;
  /** Opens a Subagent in Output's Subagent tab; absent where it already shows there. */
  readonly onOpenSubagent?: (subagentId: string) => void;
}

type Context = EntryContext;

const Run = ({ entry, ctx }: { entry: Extract<Entry, { kind: "run" }>; ctx: Context }) => {
  const [open, toggle] = useOpen(`run:${entry.id}`);

  return (
    <div className="flex flex-col" data-testid="tool-run">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="text-caption text-text-subtle hover:text-text-default flex h-6 min-w-0 cursor-default items-center gap-2 self-start"
      >
        <CheckIcon size={12} className="text-text-faint shrink-0" />
        <span className="truncate">{entry.summary}</span>
        <Chevron open={open} />
      </button>
      {open ? (
        <div className="border-hairline mt-1 ml-1.5 flex flex-col gap-1.5 border-l pl-3.5">
          {entry.items.map((item) => (
            <Item key={item.id} item={item} hue={ctx.hue} onOpenDiff={ctx.onOpenDiff} />
          ))}
        </div>
      ) : null}
    </div>
  );
};

const STATUS_LABEL = {
  working: "working",
  completed: "done",
  failed: "failed",
  interrupted: "stopped",
} as const;

const StatusMark = ({ card, hue }: { card: SubagentCard; hue: Hue }) => {
  switch (card.subagent.status) {
    case "working":
      return <LiveMark hue={hue} />;
    case "completed":
      return <CheckIcon size={14} className="text-text-subtle shrink-0" />;
    case "failed":
    case "interrupted":
      return <PixelFailedIcon size={14} className="text-failed shrink-0" />;
  }
};

const Elapsed = ({ card }: { card: SubagentCard }) => {
  const { startedAt, endedAt, status } = card.subagent;
  const running = useElapsed(startedAt, status === "working");
  const ms = endedAt === null ? running : Date.parse(endedAt) - Date.parse(startedAt);

  return (
    <span className="text-caption text-text-subtle tabular shrink-0">{formatElapsed(ms)}</span>
  );
};

/** A Subagent's task, then its own entries; the inline card's body and Output's Subagent tab. */
export const SubagentTranscript = ({
  card,
  ctx,
  taskClamp = true,
}: {
  readonly card: SubagentCard;
  readonly ctx: Context;
  /** The inline card clamps a long task to four lines; the tab shows it whole. */
  readonly taskClamp?: boolean;
}) => (
  <>
    {card.task === null ? null : (
      <p
        className={cn(
          "text-caption text-text-subtle border-hairline border-l-2 pl-3 whitespace-pre-wrap",
          taskClamp && "line-clamp-4"
        )}
      >
        {card.task}
      </p>
    )}
    {card.entries.map((entry) => (
      <EntryView key={entryId(entry)} entry={entry} ctx={ctx} />
    ))}
    {card.entries.length === 0 && card.report === null ? (
      <p className="text-caption text-text-subtle">Nothing yet</p>
    ) : null}
  </>
);

/** Its final report, once it has one. */
export const SubagentReport = ({
  card,
  className,
}: {
  readonly card: SubagentCard;
  readonly className?: string;
}) =>
  card.report === null ? null : (
    <div className={cn("text-body", className)} data-testid="subagent-report">
      <Markdown text={card.report} live={false} />
    </div>
  );

const Subagent = ({ card, ctx }: { card: SubagentCard; ctx: Context }) => {
  const [open, toggle] = useOpen(`subagent:${card.id}`);
  const { subagent } = card;
  const onOpen = ctx.onOpenSubagent;

  return (
    <div
      className={cn(WELL, "flex flex-col overflow-clip")}
      data-testid="subagent"
      data-status={subagent.status}
    >
      {/* The hover fill spans the header and its activity line; the button's ::after covers both. */}
      <div className="hover:bg-fill-hover relative flex flex-col" data-testid="subagent-head">
        <div className="flex min-w-0 items-center">
          <button
            type="button"
            aria-expanded={open}
            onClick={toggle}
            className={cn(
              "h-row gap-row-x flex min-w-0 flex-1 cursor-default items-center pl-3 text-left after:absolute after:inset-0",
              onOpen === undefined && "pr-3"
            )}
          >
            <StatusMark card={card} hue={ctx.hue} />
            <span className="text-caption text-text-default shrink-0 font-medium">
              {subagent.agent ?? "Subagent"}
            </span>
            <span className="text-body text-text-subtle min-w-0 flex-1 truncate">
              {subagent.title}
            </span>
            <Elapsed card={card} />
            {subagent.status === "working" ? null : (
              <span className="text-caption text-text-subtle shrink-0">
                {STATUS_LABEL[subagent.status]}
              </span>
            )}
            <Chevron open={open} />
          </button>
          {onOpen === undefined ? null : (
            <button
              type="button"
              onClick={() => onOpen(card.id)}
              aria-label={`Open ${subagent.agent ?? "subagent"} in output`}
              data-testid="subagent-open"
              className="text-caption text-text-subtle hover:text-text-strong relative z-10 mx-1.5 shrink-0 cursor-default rounded-full px-1.5 py-0.5"
            >
              Open
            </button>
          )}
        </div>
        {card.activity === null ? null : (
          <p
            className="text-caption text-text-subtle -mt-1.5 truncate px-3 pb-2 pl-[38px] font-mono"
            data-testid="subagent-activity"
          >
            {card.activity}
          </p>
        )}
      </div>
      {open ? (
        <div
          className="border-hairline flex flex-col gap-1.5 border-t px-3 py-2"
          data-testid="subagent-transcript"
        >
          <SubagentTranscript card={card} ctx={ctx} />
          <SubagentReport card={card} className="border-hairline mt-1.5 border-t pt-2" />
        </div>
      ) : null}
    </div>
  );
};

const entryId = (entry: Entry) => {
  switch (entry.kind) {
    case "item":
      return entry.item.id;
    case "run":
      return `run:${entry.id}`;
    case "desktop":
      return `desktop:${entry.id}`;
    case "subagent":
      return `subagent:${entry.card.id}`;
    case "sources":
      return `sources:${entry.id}`;
  }
};

export const EntryView = ({ entry, ctx }: { readonly entry: Entry; readonly ctx: Context }) => {
  switch (entry.kind) {
    case "item":
      return <Item item={entry.item} hue={ctx.hue} onOpenDiff={ctx.onOpenDiff} />;
    case "run":
      return <Run entry={entry} ctx={ctx} />;
    case "desktop":
      return (
        <DesktopRunRow
          id={entry.id}
          run={entry.run}
          items={entry.items}
          renderItem={(item) => <Item item={item} hue={ctx.hue} onOpenDiff={ctx.onOpenDiff} />}
        />
      );
    case "subagent":
      return <Subagent card={entry.card} ctx={ctx} />;
    case "sources":
      return <SourcesPill sources={entry.sources} />;
  }
};
