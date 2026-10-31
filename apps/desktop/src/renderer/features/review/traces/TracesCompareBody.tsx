/**
 * Route timings in Review's diff pane (DESIGN.md, Traces → In Review), laid out like the
 * Schema Diff: a title and what is compared, then one row per route with its p50 before →
 * after and the runs behind it. A row opens its Turn's traces in Traces (⌘5).
 */
import { cn, EmptyState, PixelForkIcon } from "@polaris/ui";
import { commandShortcut } from "../../../../shared/keymap.ts";
import {
  changeWord,
  type ComparePlan,
  openTurn,
  p50Line,
  type RouteRow,
  routeTitle,
  runsLine,
  type TracesAnswer,
} from "./model.ts";

export interface TracesCompareBodyProps {
  readonly answer: TracesAnswer;
  readonly plan: ComparePlan;
  readonly onOpenRoute: (row: RouteRow) => void;
}

export const ROUTES_FOOTNOTE =
  "p50 is the median duration of a route’s traces in each turn, given once both sides have at least 3 runs. Only traces Polaris still keeps are counted.";

/** Each row is its own grid on fixed lanes, so figures line up and nothing meets the card edge. */
const COLUMNS =
  "px-row-pad grid grid-cols-[minmax(0,1fr)_10.5rem_8.5rem_7rem] items-center gap-x-4";

const HEAD = "text-micro text-text-subtle";

const RouteLine = ({
  row,
  plan,
  onOpen,
}: {
  readonly row: RouteRow;
  readonly plan: ComparePlan;
  readonly onOpen: (row: RouteRow) => void;
}) => {
  const shortcut = commandShortcut("view.traces");
  const turn = openTurn(row, plan).number;
  const opens = turn === null ? "Open the latest earlier trace" : `Open turn ${turn}’s traces`;
  const change = changeWord(row);

  return (
    <button
      type="button"
      data-testid="traces-route"
      data-change={row.change}
      onClick={() => onOpen(row)}
      title={`${routeTitle(row)}\n${opens}${shortcut === "" ? "" : ` ${shortcut}`}`}
      className={cn(
        COLUMNS,
        "rounded-row hover:bg-fill-hover h-row focus-visible:ring-starlight w-full cursor-default text-left outline-none focus-visible:ring-2"
      )}
    >
      <span className="gap-row-x flex min-w-0 items-baseline">
        <span className="text-caption text-text-strong min-w-0 truncate font-mono">
          {row.route}
        </span>
        <span className="text-caption text-text-faint max-w-[12rem] shrink-0 truncate">
          {row.service}
        </span>
      </span>
      <span
        className={cn(
          "text-caption tabular text-right whitespace-nowrap",
          row.change === "compared" ? "text-text-default font-mono" : "text-text-subtle"
        )}
      >
        {p50Line(row)}
      </span>
      <span className="text-caption text-text-subtle tabular text-right whitespace-nowrap">
        {runsLine(row)}
      </span>
      <span className="text-caption text-text-subtle text-right whitespace-nowrap">
        {change ?? ""}
      </span>
    </button>
  );
};

const Routes = ({ answer, plan, onOpenRoute }: TracesCompareBodyProps) =>
  answer.status === "failed" ? (
    <EmptyState
      icon={<PixelForkIcon size={24} />}
      title="Route timings unavailable"
      fact={answer.message}
    />
  ) : (
    <section
      data-testid="traces-routes"
      className="border-hairline rounded-row py-gap flex flex-col border px-1"
    >
      <div className={cn(COLUMNS, "pb-1")}>
        <span className={HEAD}>Route</span>
        <span className={cn(HEAD, "text-right")}>p50 before → after</span>
        <span className={cn(HEAD, "text-right")}>Runs</span>
        <span className={cn(HEAD, "text-right")}>Change</span>
      </div>
      {answer.rows.map((row) => (
        <RouteLine key={row.key} row={row} plan={plan} onOpen={onOpenRoute} />
      ))}
      <p
        data-testid="traces-routes-footnote"
        className="text-micro text-text-subtle px-row-pad pt-1"
      >
        {ROUTES_FOOTNOTE}
      </p>
    </section>
  );

export const TracesCompareBody = (props: TracesCompareBodyProps) => (
  <div
    data-testid="traces-compare"
    data-status={props.answer.status}
    className="px-panel pt-panel pb-section gap-gap flex min-h-0 flex-1 flex-col overflow-y-auto"
  >
    <header className="flex min-w-0 flex-col gap-0.5">
      <h2 className="text-heading-sm text-text-strong min-w-0 truncate">Route timings</h2>
      {props.answer.status === "ready" && (
        <span
          data-testid="traces-compare-caption"
          className="text-caption text-text-subtle min-w-0 truncate"
        >
          {props.answer.caption}
        </span>
      )}
    </header>
    <Routes {...props} />
  </div>
);
