/**
 * A Visualization in the conversation (DESIGN.md, Visualizations): a card in place of the
 * `visualize` call, its title line over the live frame. It draws, can be revised below,
 * expanded, or stopped; off screen it keeps its height with no frame.
 */
import { ChevronRightIcon, cn, LiveDither } from "@polaris/ui";
import { linkConfirms } from "@polaris/visualization";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { formatElapsed } from "../../model/format.ts";
import type { VisualizationView } from "../../model/polarisTools/index.ts";
import { useElapsed } from "../../hooks.ts";
import { type Hue, LiveMark } from "../marks.tsx";
import { frames, lastHeights, type Nearness } from "./budget.ts";
import { useVisualizationScope } from "./context.ts";
import { Expanded } from "./Expanded.tsx";
import { Frame } from "./Frame.tsx";
import { BarsGlyph, ExpandGlyph, StopGlyph } from "./glyphs.tsx";
import { LinkDialog } from "./LinkDialog.tsx";

export { type VisualizationScope, VisualizationScopeContext } from "./context.ts";

/** The space a drawing reserves, so the conversation doesn't jump when the frame arrives. */
const DRAWING_HEIGHT = 320;

/** Frames this far beyond the viewport are near: they mount before they scroll in. */
const NEAR_MARGIN = "800px 0px";

type Shown = Extract<VisualizationView, { phase: "shown" }>;

const CARD = "bg-panel overflow-clip rounded-[12px] ring-1 ring-hairline ring-inset";

const TitleLine = ({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) => (
  <div
    className={cn(
      "bg-well border-hairline relative isolate flex h-10 min-w-0 items-center gap-2.5 border-b pr-[7px] pl-3",
      className
    )}
  >
    {children}
  </div>
);

const Title = ({ text }: { readonly text: string }) => (
  <span className="text-text-strong min-w-0 flex-1 truncate text-[14px] leading-[18px] font-medium">
    {text}
  </span>
);

const Drawing = ({
  view,
  hue,
}: {
  readonly view: Extract<VisualizationView, { phase: "drawing" }>;
  readonly hue: Hue;
}) => {
  const elapsed = useElapsed(view.startedAt, true);

  return (
    <div className={CARD} data-testid="visualization" data-phase="drawing">
      <TitleLine className="overflow-clip">
        {hue === null ? null : <LiveDither harness={hue} active className="-z-10" />}
        {hue === null ? <BarsGlyph className="text-text-subtle" /> : <LiveMark hue={hue} />}
        <Title text={view.title === "" ? "Drawing…" : `Drawing ${view.title}…`} />
        {view.startedAt === null ? null : (
          <span className="text-caption text-text-subtle tabular shrink-0 pr-1.5">
            {formatElapsed(elapsed)}
          </span>
        )}
      </TitleLine>
      <div style={{ height: DRAWING_HEIGHT }} />
    </div>
  );
};

/** Where the card sits against the viewport, told to the shared frame budget. */
const useLive = (ref: RefObject<HTMLElement | null>, key: string) => {
  useEffect(() => {
    const element = ref.current;

    if (element === null) return undefined;

    let visible = false;
    let near = false;

    const nearness = (): Nearness => {
      if (visible) return "visible";

      return near ? "near" : "away";
    };

    const place = () => frames.place(key, nearness());

    const watch = (margin: string, set: (on: boolean) => void) => {
      const observer = new IntersectionObserver(
        ([entry]) => {
          set(entry?.isIntersecting ?? false);
          place();
        },
        { rootMargin: margin }
      );

      observer.observe(element);

      return observer;
    };

    const observers = [
      watch("0px", (on) => (visible = on)),
      watch(NEAR_MARGIN, (on) => (near = on)),
    ];

    return () => {
      for (const observer of observers) observer.disconnect();
      frames.remove(key);
    };
  }, [ref, key]);

  return useSyncExternalStore(frames.subscribe, () => frames.isLive(key));
};

const ExpandButton = ({ onClick }: { readonly onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    data-testid="visualization-expand"
    className="text-caption text-text-default hover:bg-fill-hover border-hairline flex h-[26px] shrink-0 cursor-default items-center gap-[7px] rounded-full border pr-[11px] pl-[9px]"
  >
    <ExpandGlyph />
    Expand
  </button>
);

const Stopped = () => (
  <div className="flex items-start gap-3 px-4 py-4" data-testid="visualization-stopped">
    <StopGlyph className="text-text-subtle mt-px" />
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-text-default text-[14px] leading-[18px] font-medium">
        Stopped: it tried to open another page
      </span>
      <span className="text-text-subtle text-[13px] leading-[18px]">
        A visualization has to stay on its own page, so Polaris removed it. Ask the agent to draw it
        again.
      </span>
    </div>
  </div>
);

const RevisedLine = ({
  title,
  onOpen,
}: {
  readonly title: string;
  readonly onOpen: () => void;
}) => (
  <button
    type="button"
    onClick={onOpen}
    data-testid="visualization"
    data-phase="revised"
    className="hover:bg-fill-hover flex h-10 w-full min-w-0 cursor-default items-center gap-2.5 rounded-[12px] pr-3 pl-3 text-left"
  >
    <BarsGlyph className="text-text-subtle opacity-60" />
    <span className="text-text-subtle min-w-0 flex-1 truncate text-[14px] leading-[18px]">
      {title}
    </span>
    <span className="text-caption text-text-subtle shrink-0">Revised below</span>
    <ChevronRightIcon size={10} className="text-text-subtle shrink-0" />
  </button>
);

const Body = ({
  view,
  onOpenLink,
  onStopped,
}: {
  readonly view: Shown;
  readonly onOpenLink: (url: string) => void;
  readonly onStopped: () => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const live = useLive(ref, `${view.id}:${useId()}`);
  const [height, setHeight] = useState(() => lastHeights.get(view.id) ?? DRAWING_HEIGHT);

  return (
    <div ref={ref} style={{ height }} data-live={live}>
      {live ? (
        <Frame
          id={view.id}
          title={view.title}
          html={view.html}
          mode="inline"
          className="h-full"
          onHeight={(next) => {
            lastHeights.set(view.id, next);
            setHeight(next);
          }}
          onOpenLink={onOpenLink}
          onStopped={onStopped}
        />
      ) : null}
    </div>
  );
};

const ShownCard = ({ view }: { readonly view: Shown }) => {
  const scope = useVisualizationScope();
  const [reopened, setReopened] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  // A frame asking again and again gets one confirm at a time, then none (ENG-634).
  const [confirms] = useState(linkConfirms);

  const askToOpen = (url: string) => {
    if (confirms.request()) setLink(url);
  };

  if (scope.revised.has(view.id) && !reopened)
    return <RevisedLine title={view.title} onOpen={() => setReopened(true)} />;

  const stop = () => {
    setExpanded(false);
    setStopped(true);
  };

  return (
    <div
      className={CARD}
      data-testid="visualization"
      data-phase={stopped ? "stopped" : "shown"}
      data-visualization={view.id}
    >
      <TitleLine>
        <BarsGlyph className="text-text-subtle" />
        <Title text={view.title} />
        {stopped ? null : <ExpandButton onClick={() => setExpanded(true)} />}
      </TitleLine>
      {stopped ? <Stopped /> : <Body view={view} onOpenLink={askToOpen} onStopped={stop} />}
      {expanded && !stopped ? (
        <Expanded
          id={view.id}
          title={view.title}
          html={view.html}
          where={scope.where(view.id)}
          onClose={() => setExpanded(false)}
          onOpenLink={askToOpen}
          onStopped={stop}
        />
      ) : null}
      <LinkDialog
        title={view.title}
        url={link}
        onClose={(opened) => {
          confirms.settled(opened);
          setLink(null);
        }}
      />
    </div>
  );
};

export const Visualization = ({
  view,
  hue,
}: {
  readonly view: VisualizationView;
  readonly hue: Hue;
}) => (view.phase === "drawing" ? <Drawing view={view} hue={hue} /> : <ShownCard view={view} />);
