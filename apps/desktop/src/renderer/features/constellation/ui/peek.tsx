/**
 * The Space preview of a Constellation (K4; Paper X-H Variant 1): Space on a hovered or focused
 * Lead row opens an instrument card beside it, the graph drawn as a star chart. A session using
 * an app previews its live view instead (Paper CU5).
 */
import { harnessEntry, SessionId } from "@polaris/protocol";
import {
  Button,
  cn,
  InstrumentPopoverContent,
  Kicker,
  Popover,
  PopoverAnchor,
  PopoverContent,
  SegmentedControl,
} from "@polaris/ui";
import {
  type ComponentProps,
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useApp, useShellActions } from "../../../shell/hooks.ts";
import { useNow } from "../../../shell/useNow.ts";
import { peekCounts, peekRows } from "../../sessions/model/peek.ts";
import { clock } from "../model/copy.ts";
import { forYou } from "../model/glance.ts";
import { LANE_MAX, laneWidth, tallyOf, type TaskRow } from "../model/index.ts";
import {
  closeSubagent,
  controlledRun,
  currentDesktopRun,
  type DesktopRun,
  LiveView,
  useControlledApp,
} from "../../session/index.ts";
import { sessionKey } from "../../../store/store.ts";
import { leadKey, patchLeadUi } from "../state.ts";
import { StarChartHero } from "./chart.tsx";
import { TaskGlyph } from "./glyphs.tsx";
import { IdLane, laneStyle } from "./lane.tsx";
import { ID_TONE, TONE } from "./rows.tsx";
import { LeadStar } from "./stars.tsx";
import { useGlance } from "./waves.tsx";

const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * The preview's open state and its triggers: Space toggles it while the row is hovered (a
 * key listener only while the pointer is on it) or focused (the row's own key handler).
 */
export const useSpacePeek = () => {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const row = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!hovered) return undefined;

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== " " || event.repeat || editable(event.target)) return;

      // A focused row handles its own Space.
      if (event.target instanceof Node && row.current?.contains(event.target)) return;
      event.preventDefault();
      setOpen((o) => !o);
    };

    window.addEventListener("keydown", onKey);

    return () => window.removeEventListener("keydown", onKey);
  }, [hovered]);

  return {
    open,
    setOpen,
    toggle: () => setOpen((o) => !o),
    /** The row's own keys: Space previews, Enter closes the preview and opens as before. */
    keyDown:
      (next: (event: React.KeyboardEvent<HTMLElement>) => void) =>
      (event: React.KeyboardEvent<HTMLElement>) => {
        if (event.key === " ") {
          event.preventDefault();
          setOpen((o) => !o);

          return;
        }

        if (event.key === "Enter") setOpen(false);
        next(event);
      },
    rowProps: {
      onMouseEnter: (event: React.MouseEvent<HTMLElement>) => {
        row.current = event.currentTarget;
        setHovered(true);
      },
      onMouseLeave: () => setHovered(false),
    },
  };
};

const PeekRow = ({ row, text }: { readonly row: TaskRow; readonly text?: string }) => (
  <div className="gap-gap flex h-[30px] items-center px-2" data-testid="peek-task">
    <TaskGlyph glyph={row.look.glyph} harness={row.harness} size={16} />
    <IdLane id={row.task.id} max={LANE_MAX.sidebar} className={ID_TONE[row.look.idTone]} />
    <span className="text-body text-text-default min-w-0 flex-1 truncate">
      {text ?? row.task.title}
    </span>
    <span className={cn("shrink-0 font-mono text-[11px]", TONE[row.look.wordTone])}>
      {row.look.word}
    </span>
  </div>
);

const lane = (rows: ReadonlyArray<TaskRow>) =>
  laneStyle(
    laneWidth(
      rows.map((r) => r.task.id),
      LANE_MAX.sidebar
    )
  );

/** "For you · n": what the user owes the graph, loudest first. */
const ForYouWell = ({ rows }: { readonly rows: ReadonlyArray<TaskRow> }) => {
  const items = forYou(rows);

  return (
    <div
      className="flex flex-col px-2 pt-2.5 pb-1.5"
      data-testid="for-you"
      style={lane(items.map((i) => i.row))}
    >
      <Kicker parts={["For you", items.length]} className="px-2 pb-1" />
      {items.length === 0 ? (
        <p className="text-body text-text-subtle px-2 py-1.5">Nothing needs you.</p>
      ) : (
        items.map((item) => <PeekRow key={item.row.key} row={item.row} text={item.text} />)
      )}
    </div>
  );
};

/** List: the Tasks still in play, as the preview showed them before the chart. */
const ListWell = ({ rows }: { readonly rows: ReadonlyArray<TaskRow> }) => {
  const { shown, more } = peekRows(rows);

  return (
    <div className="flex flex-col px-2 py-1.5" style={lane(shown)}>
      <p className="text-caption text-text-subtle px-2 py-1">
        {peekCounts(tallyOf(rows)).map((count, n) => (
          <span key={count.bucket}>
            {n === 0 ? null : " · "}
            <span className={count.bucket === "needs-you" ? "text-needs-you-text" : undefined}>
              {count.text}
            </span>
          </span>
        ))}
      </p>
      {shown.map((row) => (
        <PeekRow key={row.key} row={row} />
      ))}
      {more === 0 ? null : <p className="text-caption text-text-subtle px-2 py-1">{more} more</p>}
    </div>
  );
};

type View = "chart" | "list";

const VIEWS: ReadonlyArray<{ readonly value: View; readonly label: string }> = [
  { value: "chart", label: "Chart" },
  { value: "list", label: "List" },
];

/** The hero grows with the graph to this, then scrolls inside (DESIGN.md, Constellation glance). */
const HERO_MAX = 280;

const useLead = (hostKey: string, leadSessionId: string) =>
  useApp(
    (s) => s.hostModels[hostKey]?.sessions.get(SessionId.make(leadSessionId))?.session ?? null
  );

const statusOf = (harness: string | null, since: string, now: number) =>
  [
    harness === null ? null : (harnessEntry(harness)?.name ?? harness),
    `lead since ${clock(since)}`,
    `as of ${clock(new Date(now).toISOString())}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");

const GlanceCard = ({
  hostKey,
  leadSessionId,
  onOpen,
  ...content
}: Omit<ComponentProps<typeof PopoverContent>, "children"> & {
  readonly hostKey: string;
  readonly leadSessionId: string;
  readonly onOpen: () => void;
}) => {
  const glance = useGlance(hostKey, leadSessionId);
  const lead = useLead(hostKey, leadSessionId);
  const now = useNow();
  const [view, setView] = useState<View>("chart");

  if (glance === null) return null;
  const c = glance.record.constellation;
  const harness = lead?.harness ?? null;
  const tasks = glance.rail.tasks;
  const leadName = lead?.title === undefined || lead.title === "" ? "its lead" : lead.title;

  return (
    <InstrumentPopoverContent
      {...content}
      data-testid="constellation-peek"
      className="w-[640px]"
      header={{
        mark: <LeadStar harness={harness} size={16} />,
        title: c.name,
        state: `led by ${leadName} · ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`,
        control: (
          <SegmentedControl
            pill
            aria-label="Show the graph as"
            value={view}
            onValueChange={setView}
            options={VIEWS}
          />
        ),
      }}
      hero={
        view === "chart" ? (
          <StarChartHero
            chart={glance.chart}
            segments={glance.segments}
            leadHarness={harness}
            seed={c.id}
          />
        ) : undefined
      }
      heroMaxHeight={HERO_MAX}
      wells={
        view === "chart"
          ? [<ForYouWell rows={tasks} />]
          : [<ForYouWell rows={tasks} />, <ListWell rows={tasks} />]
      }
      footer={{
        status: statusOf(harness, c.createdAt, now),
        action: (
          <Button size="sm" variant="secondary" className="rounded-full" onClick={onOpen}>
            Open constellation
          </Button>
        ),
      }}
    />
  );
};

/** Triggers around the preview (a menu, a hover card) pass their props through to the row. */
export interface ConstellationPeekProps extends Omit<
  ComponentProps<typeof PopoverAnchor>,
  "asChild" | "children"
> {
  readonly hostKey: string;
  readonly leadSessionId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The Lead row it opens beside. */
  readonly children: ReactElement;
}

export const ConstellationPeek = ({
  hostKey,
  leadSessionId,
  open,
  onOpenChange,
  children,
  ...slot
}: ConstellationPeekProps) => {
  const { selectSession } = useShellActions();

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild {...slot}>
        {children}
      </PopoverAnchor>
      {open ? (
        <GlanceCard
          hostKey={hostKey}
          leadSessionId={leadSessionId}
          side="right"
          align="start"
          sideOffset={10}
          // The row keeps focus, so Space and ↵ still reach it.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onOpen={() => {
            onOpenChange(false);
            selectSession({ hostKey, sessionId: SessionId.make(leadSessionId) });
            closeSubagent(hostKey, leadSessionId);
            patchLeadUi(leadKey(hostKey, leadSessionId), () => ({
              tab: "constellation",
              focus: null,
            }));
          }}
        />
      ) : null}
    </Popover>
  );
};

/**
 * The app a session is using now: its working Turn's run when its feed is open, else the app the
 * Host feed says it controls; null for a session using none.
 */
export const useLiveRun = (hostKey: string, sessionId: string): DesktopRun | null => {
  const id = SessionId.make(sessionId);
  const model = useApp((s) => s.sessions[sessionKey(hostKey, id)]);
  const controlled = useControlledApp(hostKey, id);

  return useMemo(
    () => currentDesktopRun(model) ?? (controlled === null ? null : controlledRun(controlled)),
    [model, controlled]
  );
};

export interface LivePeekProps extends Omit<
  ComponentProps<typeof PopoverAnchor>,
  "asChild" | "children"
> {
  readonly hostKey: string;
  readonly sessionId: string;
  /** From `useLiveRun`; the row previews nothing without one. */
  readonly run: DesktopRun;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly children: ReactElement;
}

const peekFooter = (run: DesktopRun, turn: number | null) =>
  [run.appName, run.items.length === 0 ? null : run.doing, turn === null ? null : `turn ${turn}`]
    .filter((part) => part !== null)
    .join(" · ");

/**
 * Space on a session row whose Turn is using an app: the same live view as the transcript's
 * popover, titled with the session. Its content mounts only while open, so only then does the
 * Host capture.
 */
export const LivePeek = ({
  hostKey,
  sessionId,
  run,
  open,
  onOpenChange,
  children,
  ...slot
}: LivePeekProps) => {
  const id = SessionId.make(sessionId);
  const session = useApp((s) => s.hostModels[hostKey]?.sessions.get(id)?.session ?? null);
  const turn = session?.currentUserTurn?.number ?? session?.turnCount ?? null;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild {...slot}>
        {children}
      </PopoverAnchor>
      {open ? (
        <PopoverContent
          side="right"
          align="start"
          sideOffset={10}
          data-surface="raised"
          data-testid="live-peek"
          className="bg-raised rounded-card w-[300px] p-0"
          // The row keeps focus, so Space still reaches it.
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <LiveView
            hostKey={hostKey}
            sessionId={id}
            run={run}
            title={session?.title || "Untitled session"}
            liveFooter={peekFooter(run, turn)}
          />
        </PopoverContent>
      ) : null}
    </Popover>
  );
};
