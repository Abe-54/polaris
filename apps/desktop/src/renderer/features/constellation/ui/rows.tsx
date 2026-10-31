/**
 * The rail's rows (DESIGN.md, Rows, not a canvas): fixed lanes of rail (60px), id (the view's
 * `--id-lane`), title, actor and state, plus at most two caption lines that carry state.
 */
import { Button, ChevronRightIcon, cn, DisclosureChevron } from "@polaris/ui";
import { Fragment, type ReactNode } from "react";
import {
  type ClaimGlance,
  clock,
  type Line,
  type Liveness,
  type ParentRow,
  pluralize,
  type RailRow,
  setupExit,
  shortSha,
  type Tally,
  tallyBar,
  type TaskRow,
  type Tone,
  LANE_MAX,
  TRUNK,
} from "../model/index.ts";
import { InputDot, TaskGlyph } from "./glyphs.tsx";
import { IdLane, LaneSpacer } from "./lane.tsx";
import { overflowIndent, Rail } from "./rail.tsx";
import { Checks, StripBar } from "./strip.tsx";

export const TONE: Readonly<Record<Tone, string>> = {
  neutral: "text-text-default",
  accepted: "text-accepted-text",
  "needs-you": "text-needs-you-text",
  failed: "text-failed-text",
  faint: "text-text-faint",
};

export const ID_TONE: Readonly<Record<Tone, string>> = { ...TONE, neutral: "text-text-subtle" };

/** A row's second line; `wrap` lets a Claim's checks run onto more lines rather than clip. */
const Caption = ({
  children,
  className,
  wrap = false,
}: {
  children: ReactNode;
  className?: string;
  wrap?: boolean;
}) => (
  <p
    className={cn(
      "text-caption text-text-subtle flex min-w-0 items-center gap-2",
      wrap ? "flex-wrap gap-y-0.5" : "overflow-hidden whitespace-nowrap",
      className
    )}
  >
    {children}
  </p>
);

const LivenessLine = ({ line }: { readonly line: Liveness }) => (
  <Caption>
    {line.idle ? <span className="shrink-0">waiting, not working</span> : null}
    {line.activity === null ? null : (
      <span className={cn("truncate", line.mono && "text-code-inline font-mono")}>
        {line.activity}
        {line.duration === null ? null : <span className="font-sans"> · {line.duration}</span>}
      </span>
    )}
    {line.progress === null ? null : <span className="truncate">{line.progress}</span>}
    {line.context === null ? null : (
      <span className="text-text-subtle tabular shrink-0">context {line.context}%</span>
    )}
    {line.queued === 0 ? null : (
      <span className="text-text-subtle shrink-0">{line.queued} queued</span>
    )}
    {line.quiet === null ? null : <span className="text-text-subtle shrink-0">{line.quiet}</span>}
    {line.away === null ? null : <span className="text-text-faint">{line.away}</span>}
  </Caption>
);

const ClaimLine = ({ glance }: { readonly glance: ClaimGlance }) => (
  <Caption wrap>
    <span className="text-code-inline font-mono">{shortSha(glance.head)}</span>
    <Checks checks={glance.checks} />
    {glance.notDone === 0 ? null : (
      <span className="whitespace-nowrap">{glance.notDone} not done</span>
    )}
    {glance.questions === 0 ? null : (
      <span className="text-needs-you-text whitespace-nowrap">
        {pluralize(glance.questions, "question")}
      </span>
    )}
    {glance.asserted ? <span className="text-text-subtle whitespace-nowrap">no checks</span> : null}
    {glance.approved ? (
      <span className="text-accepted-text whitespace-nowrap">you approved</span>
    ) : null}
  </Caption>
);

type SetupLineData = Extract<Line, { kind: "setup" }>;

const setupTail = (line: SetupLineData) => {
  return line.failed ? setupExit(line) : `· ${line.duration}`;
};

const SetupLine = ({ line }: { readonly line: SetupLineData }) => (
  <Caption>
    <span className="flex min-w-0 items-center gap-1 truncate">
      {line.failed ? null : <span className="shrink-0">setting up ·</span>}
      <span className="text-code-inline truncate font-mono">{line.command}</span>
      <span className="shrink-0">{setupTail(line)}</span>
    </span>
    {line.remoteHost === null ? null : (
      <span className="text-text-subtle shrink-0">on {line.remoteHost}</span>
    )}
  </Caption>
);

/** "blocked by F1b" with each id in its state's tone, or "waiting on the lead"; the reason. */
const BlockedLine = ({ line }: { readonly line: Extract<Line, { kind: "blocked" }> }) => (
  <Caption>
    {line.on.length === 0 ? (
      <span className="shrink-0">waiting on the lead</span>
    ) : (
      <span className="shrink-0">
        blocked by{" "}
        {line.on.map((target, n) => (
          <Fragment key={target.id}>
            {n === 0 ? null : ", "}
            <span className={cn("text-code-inline font-mono", ID_TONE[target.tone])}>
              {target.id}
            </span>
          </Fragment>
        ))}
      </span>
    )}
    {line.reason === null ? null : <span className="text-text-subtle truncate">{line.reason}</span>}
  </Caption>
);

const LineView = ({ line }: { readonly line: Line }) => {
  switch (line.kind) {
    case "blocked":
      return <BlockedLine line={line} />;
    case "setup":
      return <SetupLine line={line} />;
    case "liveness":
      return <LivenessLine line={line} />;
    case "claim":
      return <ClaimLine glance={line.glance} />;
    case "accepted":
      return (
        <Caption wrap>
          <span className="text-code-inline font-mono">{shortSha(line.head)}</span>
          <Checks checks={line.receipts} reportedHollow />
        </Caption>
      );
    case "note":
      return (
        <Caption>
          <span className={cn("truncate", line.tone === "needs-you" && "text-needs-you-text")}>
            {line.text}
          </span>
          {line.detail === null ? null : <span className="text-text-faint">{line.detail}</span>}
        </Caption>
      );
  }
};

export interface RowHandlers {
  /** Folds or opens a group (by name) or a parent (by its `fold` key). */
  readonly onToggleGroup: (group: string) => void;
  readonly onFocus: (row: TaskRow) => void;
  readonly onReview: (row: TaskRow, mode: "accept" | "send-back") => void;
  /** Records the user's verdict on a handed-up Claim; the Lead merges and accepts. */
  readonly onApprove: (row: TaskRow) => void;
  /** Dispatches a Task whose worktree setup failed again, on the same worker Session. */
  readonly onRetrySetup: (row: TaskRow) => void;
  /** Restarts a stalled worker's startup on its Host: a fresh slot, then its brief once. */
  readonly onStartWorker: (row: TaskRow) => void;
  readonly onProposal: (proposalId: string, accept: boolean) => void;
  readonly onHandover: (revision: number) => void;
  /** The row's ⋯ menu, rendered by the tab. */
  readonly menu: (row: TaskRow) => ReactNode;
}

const TaskTitle = ({ row }: { readonly row: TaskRow }) => (
  <span className="text-body text-text-default flex min-w-0 flex-1 items-center gap-1.5">
    {row.inputs === null ? null : (
      <span className="flex shrink-0 items-center gap-[3px]" aria-hidden>
        {row.inputs.map((input) => (
          <InputDot key={input.taskId} glyph={input.glyph} harness={input.harness} />
        ))}
        <span className="text-text-faint pl-0.5">→</span>
      </span>
    )}
    <span className="truncate">{row.task.title}</span>
    <Also deps={row.also} />
  </span>
);

/** "← M, X": its deps other than the row it hangs under, each id in its state's tone. */
const Also = ({ deps }: { readonly deps: TaskRow["also"] }) =>
  deps.length === 0 ? null : (
    <span
      className="text-caption text-text-faint shrink-0 whitespace-nowrap"
      aria-label={`also after ${deps.map((d) => d.id).join(", ")}`}
    >
      {"← "}
      {deps.map((dep, n) => (
        <Fragment key={dep.id}>
          {n === 0 ? null : ", "}
          <span className={cn("text-code-inline font-mono", ID_TONE[dep.tone])}>{dep.id}</span>
        </Fragment>
      ))}
    </span>
  );

/** "blocks F2": a row whose Task a blocked Attempt waits on. */
const Blocks = ({ ids }: { readonly ids: ReadonlyArray<string> }) =>
  ids.length === 0 ? null : (
    <span className="text-caption text-text-subtle shrink-0 whitespace-nowrap">
      blocks <span className="text-code-inline font-mono">{ids.join(", ")}</span>
    </span>
  );

/** The buttons on a row's second line: Retry a failed setup, Start a stalled worker, decide a Claim. */
const RowActions = ({ row, on }: { readonly row: TaskRow; readonly on: RowHandlers }) => (
  <>
    {row.setup?.failed === true ? (
      <span className="flex shrink-0 gap-1.5 pr-9">
        <Button size="xs" onClick={() => on.onRetrySetup(row)}>
          Retry
        </Button>
        <Button size="xs" variant="ghost" onClick={() => on.onFocus(row)}>
          Open the log
        </Button>
      </span>
    ) : null}
    {row.look.attention?.kind === "stalled" ? (
      <span className="flex shrink-0 gap-1.5 pr-9">
        <Button size="xs" onClick={() => on.onStartWorker(row)}>
          Start
        </Button>
      </span>
    ) : null}
    {row.promoted ? (
      <span className="flex shrink-0 gap-1.5 pr-9">
        {row.look.attention?.kind === "handed" ? (
          <Button size="xs" onClick={() => on.onApprove(row)}>
            Approve
          </Button>
        ) : (
          <Button size="xs" onClick={() => on.onReview(row, "accept")}>
            Accept…
          </Button>
        )}
        <Button size="xs" variant="ghost" onClick={() => on.onReview(row, "send-back")}>
          Send back…
        </Button>
      </span>
    ) : null}
  </>
);

const TaskView = ({
  row,
  on,
  step,
}: {
  readonly row: TaskRow;
  readonly on: RowHandlers;
  readonly step: number;
}) => (
  <div
    className="min-h-tree-row flex w-full items-stretch pr-3 pl-3 @max-[26rem]:pr-1.5"
    data-task={row.task.id}
  >
    <Rail tree={row.tree} step={step} accepted={row.look.bucket === "done"}>
      <TaskGlyph glyph={row.look.glyph} harness={row.harness} />
    </Rail>
    <div
      className="flex min-w-0 flex-1 flex-col gap-0.5 py-[5px]"
      style={overflowIndent(row.tree.depth, step)}
    >
      <div className="flex min-w-0 items-center gap-3">
        <IdLane id={row.task.id} max={LANE_MAX.tab} className={ID_TONE[row.look.idTone]} />
        <TaskTitle row={row} />
        <span className="text-body text-text-subtle hidden w-[9.5rem] shrink-0 truncate text-right @[42rem]:block">
          {row.actor}
        </span>
        <span className="flex w-[7.5rem] shrink-0 items-center justify-end gap-1.5 text-right @max-[26rem]:w-20">
          <span className={cn("text-body truncate", TONE[row.look.wordTone])}>{row.look.word}</span>
          {row.look.evidence === null ? null : (
            <span className="text-body text-text-subtle">{row.look.evidence}</span>
          )}
        </span>
        <span className="w-6 shrink-0">{row.attempt === null ? null : on.menu(row)}</span>
      </div>
      {row.line === null && !row.promoted && row.blocks.length === 0 ? null : (
        <div className="flex min-w-0 items-center gap-3">
          <LaneSpacer />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {row.line === null ? null : (
              <div className="min-w-0 shrink">
                <LineView line={row.line} />
              </div>
            )}
            <Blocks ids={row.blocks} />
          </div>
          <RowActions row={row} on={on} />
        </div>
      )}
      {row.overlap === null ? null : (
        <div className="flex min-w-0 gap-3">
          <LaneSpacer />
          <Caption className="flex-1">
            <span aria-hidden className="text-text-faint">
              ⧉
            </span>
            <span>Area overlaps {row.overlap.with}</span>
            <span className="text-code-inline text-text-subtle truncate font-mono">
              {row.overlap.glob}
            </span>
          </Caption>
        </div>
      )}
    </div>
  </div>
);

const TallyText = ({ tally }: { readonly tally: Tally }) => {
  const parts: Array<ReactNode> = [];

  if (tally["needs-you"] > 0)
    parts.push(
      <span key="ny" className="text-needs-you-text">
        {tally["needs-you"]} needs you
      </span>
    );

  if (tally.review > 0) parts.push(<span key="r">{tally.review} in review</span>);

  if (tally.working > 0) parts.push(<span key="w">{tally.working} working</span>);

  if (tally.blocked > 0) parts.push(<span key="b">{tally.blocked} blocked</span>);

  if (tally.waiting > 0 && tally.working + tally.review + tally["needs-you"] + tally.blocked === 0)
    parts.push(<span key="wt">{tally.waiting} waiting</span>);

  return (
    <span className="text-body text-text-subtle flex min-w-[7.5rem] shrink items-center justify-end gap-1.5 overflow-hidden whitespace-nowrap @max-[26rem]:min-w-20">
      {parts.flatMap((p, n) => (n === 0 ? [p] : [<span key={`s${n}`}>·</span>, p]))}
      {tally.done > 0 ? <span className="text-accepted-text pl-1">{tally.done} done</span> : null}
    </span>
  );
};

/** A group's heading: its label on the id lane, its tally ending on the state lane. */
const Chevron = ({ open }: { readonly open: boolean }) => (
  <DisclosureChevron open={open} className="text-text-subtle" />
);

const GroupView = ({
  row,
  on,
  large,
  step,
}: {
  readonly row: Extract<RailRow, { kind: "group" }>;
  readonly on: RowHandlers;
  readonly large: boolean;
  readonly step: number;
}) => (
  <button
    type="button"
    aria-expanded={row.open}
    onClick={() => on.onToggleGroup(row.group)}
    className="min-h-tree-row flex w-full cursor-default items-stretch pr-3 pl-3 text-left @max-[26rem]:pr-1.5"
  >
    <Rail tree={TRUNK} step={step} trail={<Chevron open={row.open} />}>
      <TaskGlyph glyph={row.glyph} harness={null} />
    </Rail>
    <span className="flex min-w-0 flex-1 py-[5px]">
      <span className="flex min-h-(--text-body--line-height) min-w-0 flex-1 items-center gap-3">
        <span className="text-label text-text-strong flex min-w-24 flex-1 items-center gap-1.5">
          <span className="truncate">{row.label}</span>
          {large ? (
            <span className="text-body text-text-subtle tabular shrink-0">
              {row.total}
              {row.tally.proposed > 0 ? ` · ${row.tally.proposed} proposed` : ""}
            </span>
          ) : null}
        </span>
        {large ? (
          <span className="hidden w-[9.5rem] shrink-0 justify-end @[44rem]:flex">
            <StripBar parts={tallyBar(row.tally, row.total)} width={120} />
          </span>
        ) : null}
        <TallyText tally={row.tally} />
        <span className="w-6 shrink-0" />
      </span>
    </span>
  </button>
);

/**
 * A parent Task: its id and title on their lanes, its leaves' tally ending on the state lane,
 * the rollup's glyph on its depth's column and its chevron in the rail. It has no Attempt.
 */
const ParentView = ({
  row,
  on,
  step,
}: {
  readonly row: ParentRow;
  readonly on: RowHandlers;
  readonly step: number;
}) => (
  <button
    type="button"
    aria-expanded={row.open}
    aria-label={`${row.task.id} · ${row.task.title}, ${row.total} tasks`}
    onClick={() => on.onToggleGroup(row.fold)}
    className="min-h-tree-row flex w-full cursor-default items-stretch pr-3 pl-3 text-left @max-[26rem]:pr-1.5"
    data-parent={row.task.id}
  >
    <Rail
      tree={row.tree}
      step={step}
      accepted={row.tally.done === row.total}
      trail={<Chevron open={row.open} />}
    >
      <TaskGlyph glyph={row.glyph} harness={null} />
    </Rail>
    <span className="flex min-w-0 flex-1 py-[5px]" style={overflowIndent(row.tree.depth, step)}>
      <span className="flex min-h-(--text-body--line-height) min-w-0 flex-1 items-center gap-3">
        <IdLane
          id={row.task.id}
          max={LANE_MAX.tab}
          className={row.glyph === "needs-you" ? "text-needs-you-text" : "text-text-subtle"}
        />
        <span className="text-body text-text-strong min-w-24 flex-1 truncate">
          {row.task.title}
        </span>
        <TallyText tally={row.tally} />
        <span className="w-6 shrink-0" />
      </span>
    </span>
  </button>
);

/** A Subagent under its Attempt (DESIGN.md, Subagents are nodes): smaller glyph, "subagent". */
const SubagentView = ({
  row,
  on,
  step,
}: {
  readonly row: Extract<RailRow, { kind: "subagent" }>;
  readonly on: RowHandlers;
  readonly step: number;
}) => (
  <button
    type="button"
    onClick={() => on.onFocus(row.parent)}
    className="h-tree-row flex w-full cursor-default items-stretch pr-3 pl-3 text-left @max-[26rem]:pr-1.5"
    data-subagent={row.subagent.id}
  >
    <Rail tree={row.tree} step={step} small>
      <TaskGlyph glyph="working" harness={row.parent.harness} size={12} />
    </Rail>
    <span
      className="flex min-w-0 flex-1 items-center gap-3"
      style={overflowIndent(row.tree.depth, step)}
    >
      <LaneSpacer />
      <span className="text-body text-text-subtle min-w-0 flex-1 truncate">
        {row.subagent.title}
      </span>
      <span className="text-body text-text-subtle hidden w-[9.5rem] shrink-0 truncate text-right @[42rem]:block">
        {row.subagent.agent === null ? "subagent" : `subagent · ${row.subagent.agent}`}
      </span>
      <span className="text-body text-text-default w-[7.5rem] shrink-0 text-right @max-[26rem]:w-20">
        working · {row.age}
      </span>
      <span className="w-6 shrink-0" />
    </span>
  </button>
);

export const RowView = ({
  row,
  on,
  large,
  step,
}: {
  readonly row: RailRow;
  readonly on: RowHandlers;
  readonly large: boolean;
  /** The view's rail step (`railStep` of its deepest row). */
  readonly step: number;
}) => {
  switch (row.kind) {
    case "task":
      return <TaskView row={row} on={on} step={step} />;
    case "parent":
      return <ParentView row={row} on={on} step={step} />;
    case "group":
      return <GroupView row={row} on={on} large={large} step={step} />;
    case "handover":
      return (
        <div className="h-tree-row flex w-full items-stretch pr-3 pl-3 @max-[26rem]:pr-1.5">
          <Rail tree={TRUNK} step={step}>
            <span className="bg-text-faint size-[5px] rounded-full" />
          </Rail>
          <span className="text-body text-text-subtle flex flex-1 items-center">
            Handed to a new lead at {clock(row.handover.at)}
          </span>
          <Button size="xs" variant="ghost" onClick={() => on.onHandover(row.handover.revision)}>
            Summary ›
          </Button>
          <span className="w-6 shrink-0" />
        </div>
      );
    case "proposal":
      return (
        <div className="h-tree-row flex w-full items-stretch pr-3 pl-3 @max-[26rem]:pr-1.5">
          <Rail tree={row.tree} step={step}>
            <TaskGlyph glyph="future" harness={null} />
          </Rail>
          <span className="flex min-w-0 flex-1 items-center gap-3">
            <LaneSpacer />
            <span className="text-body text-text-default truncate">{row.proposal.task.title}</span>
            {row.by === null ? null : (
              <span className="text-body text-text-subtle shrink-0">proposed by {row.by}</span>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <Button size="xs" onClick={() => on.onProposal(row.proposal.proposalId, true)}>
              Accept
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => on.onProposal(row.proposal.proposalId, false)}
            >
              Decline
            </Button>
          </span>
          <span className="w-6 shrink-0" />
        </div>
      );
    case "waiting":
      return (
        <div className="h-tree-row flex w-full items-stretch pr-3 pl-3 @max-[26rem]:pr-1.5">
          <Rail tree={row.tree} step={step}>
            <TaskGlyph glyph="waiting" harness={null} />
          </Rail>
          <button
            type="button"
            onClick={() => on.onToggleGroup(row.group)}
            className="text-body text-text-subtle flex flex-1 cursor-default items-center gap-1.5 text-left"
          >
            <ChevronRightIcon size={10} />
            {row.count} waiting · {row.ids}
          </button>
        </div>
      );
    case "subagent":
      return <SubagentView row={row} on={on} step={step} />;
    case "note":
      return (
        <p className="text-caption text-text-subtle h-tree-row flex items-center pr-3 pl-[calc(0.75rem+60px)]">
          {row.text}
        </p>
      );
  }
};
