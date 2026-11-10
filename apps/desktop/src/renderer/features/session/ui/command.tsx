/**
 * A command in the conversation: its line with how it ended, and its output
 * tail in a well. Once it succeeds the output folds to that line after a
 * moment (`model/collapse.ts`); a click on the line opens or folds it, and
 * open, the line wraps to the whole command. Folded, a line that hides part of it opens the
 * whole command in a hover card (`commandCard.tsx`).
 */
import { CheckIcon, cn, DisclosureChevron, PixelFailedIcon } from "@polaris/ui";
import { type ReactElement, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import {
  chooseCollapse,
  COLLAPSE_DELAY_MS,
  collapseChoice,
  outputOpen,
} from "../model/collapse.ts";
import { plural } from "../model/format.ts";
import { type ItemView, lineCount, outputTail } from "../model/items.ts";
import { shellRuns } from "../model/shellSyntax.ts";
import { BackgroundAction } from "./backgroundAction.tsx";
import { CommandCard } from "./commandCard.tsx";
import { type Hue, LiveMark, WELL } from "./items.tsx";
import { SyntaxRuns } from "./LineCode.tsx";

type CommandView = Extract<ItemView, { kind: "command" }>;

const TAIL_LINES = 8;

/** The user's own command: the prompt bubble's fill. */
const OWN = "rounded-card bg-fill-selected";

const exitLabel = (item: CommandView): string => {
  if (item.status === "declined") return "declined";

  if (item.live || item.status === "running") return "running";

  if (item.inBackground === true) return "in the background";

  return item.exitCode === null ? item.status : `exit ${item.exitCode}`;
};

/**
 * Whether the fold's delay has passed: at once for a command already done when
 * it mounts; for one seen finishing, after the delay and once the pointer has
 * left it, so nothing folds under the reader.
 */
const useSettled = (done: boolean) => {
  const doneAtMount = useRef(done);
  const [elapsed, setElapsed] = useState(false);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (!done || doneAtMount.current) return undefined;
    const timer = setTimeout(() => setElapsed(true), COLLAPSE_DELAY_MS);

    return () => clearTimeout(timer);
  }, [done]);

  return {
    settled: doneAtMount.current || (elapsed && !hovered),
    hover: {
      onPointerEnter: () => setHovered(true),
      onPointerLeave: () => setHovered(false),
    },
  };
};

const Output = ({
  output,
  newlines,
}: {
  readonly output: string;
  readonly newlines: number | undefined;
}) => {
  const [all, setAll] = useState(false);
  const tail = outputTail(output, TAIL_LINES, newlines);

  return (
    <div className="border-hairline border-t" data-testid="command-output">
      {tail.hidden > 0 ? (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="text-caption text-text-subtle hover:text-text-default w-full cursor-default px-3 pt-1.5 text-left"
        >
          {all ? "Show the last lines" : `Show ${tail.hidden} earlier lines`}
        </button>
      ) : null}
      <pre className="text-code-inline text-text-subtle max-h-[480px] overflow-auto px-3 py-2 font-mono leading-[18px] break-all whitespace-pre-wrap">
        {all ? output : tail.text}
      </pre>
    </div>
  );
};

const StatusMark = ({ item, failed, hue }: { item: CommandView; failed: boolean; hue: Hue }) => {
  if (item.live) return <LiveMark hue={hue} />;

  return failed ? (
    <PixelFailedIcon size={14} className="text-failed" />
  ) : (
    <CheckIcon size={14} className="text-text-subtle" />
  );
};

/** Whether the command is open, and its toggle: `model/collapse.ts`, with the user's choice. */
const useFold = (item: CommandView) => {
  const running = item.live || item.status === "running";
  const failed = item.status === "failed" || (item.exitCode !== null && item.exitCode !== 0);
  const hasOutput = item.output !== "";
  const { settled, hover } = useSettled(!running);
  const [choice, setChoice] = useState(() => collapseChoice(item.id));

  // Without output there's nothing to show unless asked: only the whole command.
  const open = hasOutput ? outputOpen({ running, failed, settled, choice }) : (choice ?? false);

  const toggle = () => {
    chooseCollapse(item.id, !open);
    setChoice(!open);
  };

  return { running, failed, hasOutput, open, toggle, hover };
};

const Line = ({
  item,
  hue,
  failed,
  open,
  canFold,
  sigil,
  textRef,
  card,
}: {
  readonly item: CommandView;
  readonly hue: Hue;
  readonly failed: boolean;
  readonly open: boolean;
  readonly canFold: boolean;
  readonly sigil: string;
  readonly textRef: RefObject<HTMLSpanElement | null>;
  /** Wraps the text as the hover card's trigger while the row itself isn't one. */
  readonly card: ((text: ReactElement) => ReactElement) | null;
}) => {
  const runs = useMemo(() => shellRuns(item.command), [item.command]);

  const text = (
    <span
      ref={textRef}
      tabIndex={card === null ? undefined : 0}
      className={cn(
        "text-code-inline text-text-default focus-visible:outline-starlight min-w-0 flex-1 font-mono focus-visible:outline-2",
        open ? "py-1.5 break-all whitespace-pre-wrap" : "truncate"
      )}
      data-testid="command-text"
    >
      {item.command === "" ? (
        "Running a command"
      ) : (
        <>
          {`${sigil} `}
          <SyntaxRuns runs={runs} />
        </>
      )}
    </span>
  );

  return (
    <>
      <StatusMark item={item} failed={failed} hue={hue} />
      {card === null ? text : card(text)}
      {item.output !== "" && canFold && !open ? (
        <span className="text-caption text-text-subtle tabular">
          {plural(lineCount(item.output, item.outputNewlines), "line")}
        </span>
      ) : null}
      <span className="text-caption text-text-subtle tabular">{exitLabel(item)}</span>
      {canFold ? <Chevron open={open} /> : null}
    </>
  );
};

const Chevron = ({ open }: { readonly open: boolean }) => (
  <DisclosureChevron open={open} className="text-text-faint" />
);

/** `own`: the user's shell command (`!`), in their lane on the prompt's fill, not an agent's well. */
export const Command = ({
  item,
  hue,
  own = false,
}: {
  readonly item: CommandView;
  readonly hue: Hue;
  readonly own?: boolean;
}) => {
  const { running, failed, hasOutput, open, toggle, hover } = useFold(item);
  // Always, so a long command can be read whole even with no output.
  const canFold = !running;
  const textRef = useRef<HTMLSpanElement>(null);

  const withCard = (trigger: ReactElement) => (
    <CommandCard command={item.command} status={exitLabel(item)} line={textRef} disabled={open}>
      {trigger}
    </CommandCard>
  );

  const line = (
    <Line
      item={item}
      hue={hue}
      failed={failed}
      open={open}
      canFold={canFold}
      sigil={own ? "!" : "$"}
      textRef={textRef}
      card={canFold || item.command.trim() === "" ? null : withCard}
    />
  );

  return (
    <div
      className={cn(own ? OWN : WELL, "group/command flex flex-col overflow-clip")}
      data-testid="command"
      data-menu-command={item.id}
      data-folded={canFold && !open ? "" : undefined}
      {...hover}
    >
      {canFold ? (
        withCard(
          <button
            type="button"
            aria-expanded={open}
            onClick={toggle}
            className="min-h-row gap-row-x hover:bg-fill-hover flex cursor-default items-center px-3 text-left"
          >
            {line}
          </button>
        )
      ) : (
        <div className="min-h-row gap-row-x flex items-center px-3">
          {line}
          <BackgroundAction itemId={item.id} />
        </div>
      )}
      {hasOutput && open ? <Output output={item.output} newlines={item.outputNewlines} /> : null}
      {!hasOutput && open ? (
        <p className="text-caption text-text-subtle border-hairline border-t px-3 py-1.5">
          No output
        </p>
      ) : null}
    </div>
  );
};
