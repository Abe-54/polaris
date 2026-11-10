/**
 * The queue on Review's left, on the ground (Paper R1 1TC-0, X-G): what's waiting to be
 * reviewed, the open subject selected, Reviewed folded, the open subject's files under it,
 * and "Review a PR by URL" at its foot. The header goes back to the list; a pull request's
 * row opens its menu on right-click.
 */
import {
  cn,
  DisclosureChevron,
  Kbd,
  KICKER,
  SEVERITY_LABELS,
  SeverityGlyph,
  Tile,
} from "@polaris/ui";
import { type ReactElement, type ReactNode, useEffect, useState } from "react";
import { reviewDigits } from "../../../routes/review.ts";
import { shortcutLabel } from "../../../routes/topBar.ts";
import type { RiskMark } from "../model/findings.ts";
import type { OpenPull } from "../../../../shared/api.ts";
import { ByUrl } from "../../pulls/ui/ByUrl.tsx";
import { PullGlyph } from "../../pulls/ui/glyphs.tsx";
import { useCompare } from "../checkout/newCommits.ts";
import { type QueueGroup, type QueuePull, type QueueRow, visibleRows } from "../model/queue.ts";
import { PullMenu } from "./pullMenu.tsx";

export interface QueueProps {
  readonly groups: ReadonlyArray<QueueGroup>;
  readonly caption: string;
  readonly selected: string | null;
  readonly onOpen: (row: QueueRow) => void;
  readonly onOpenPull: (pull: OpenPull) => void;
  readonly onList: () => void;
  /** The row's Risk Summary, when one ran this launch: its highest Severity and count. */
  readonly markOf: (row: QueueRow) => RiskMark | null;
  /** Whether a folding group (Reviewed) is open; closed by default. */
  readonly reviewedOpen: boolean;
  readonly onReviewedOpen: (open: boolean) => void;
  /** Under the queue: where the open subject's file list goes. */
  readonly files?: ReactNode;
}

/** "▲ 1": the highest Severity's glyph and how many findings have it (DESIGN.md, Review → Queue). */
const Mark = ({ mark }: { readonly mark: RiskMark | null }) =>
  mark === null ? null : (
    <span
      data-testid="review-queue-risk"
      className="text-micro tabular flex shrink-0 items-center gap-1 font-medium"
      style={{ color: `var(--color-severity-${mark.severity}-text)` }}
    >
      <SeverityGlyph severity={mark.severity} tone="text" />
      <span className="sr-only">{SEVERITY_LABELS[mark.severity]}</span>
      {mark.count}
    </span>
  );

/** Whether Control is held: the first nine rows show their ⌃N (Ctrl+N off macOS). */
const useCtrlHeld = () => {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === "Control") setHeld(!event.metaKey && !event.altKey && !event.shiftKey);
    };

    const up = (event: KeyboardEvent) => {
      if (event.key === "Control" || !event.ctrlKey) setHeld(false);
    };

    const blur = () => setHeld(false);

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);

    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  return held;
};

/** ⌃1…⌃9 open the first nine rows in the order they show. */
const useDigits = (rows: ReadonlyArray<QueueRow>, onOpen: (row: QueueRow) => void) => {
  useEffect(() => {
    const pick = (index: number) => {
      const row = rows[index];

      if (row === undefined) return false;
      onOpen(row);

      return true;
    };

    reviewDigits.pick = pick;

    return () => {
      if (reviewDigits.pick === pick) reviewDigits.pick = null;
    };
  }, [rows, onOpen]);
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "3 new commits · #88 · atlas · mchen": back in Review requested after a push. */
const PushedMeta = ({ row }: { readonly row: QueuePull }) => {
  const base = row.since?.commitOid ?? null;
  const head = row.head;
  const compare = useCompare(row.pull.repo, base === null ? null : { base, head });

  const count =
    compare === null || compare.status === "diverged" || compare.total === 0
      ? "New commits"
      : plural(compare.total, "new commit");

  return (
    <span className="text-caption text-text-subtle truncate" data-testid="review-queue-pushed">
      {count} · {row.meta}
    </span>
  );
};

const TallRow = ({ row, selected }: { readonly row: QueueRow; readonly selected: boolean }) => (
  <>
    {row.kind === "pull" ? (
      <span
        className={cn(
          "flex size-tree-row shrink-0 items-center justify-center rounded-[8px]",
          selected ? "bg-fill-selected text-text-default" : "bg-surface-raised text-text-subtle"
        )}
      >
        <PullGlyph />
      </span>
    ) : (
      <Tile hue={row.harness} size={28} />
    )}
    <span className="flex min-w-0 flex-1 flex-col gap-px text-left">
      <span
        className={cn(
          "text-body line-clamp-1 font-medium",
          selected ? "text-text-strong" : "text-text-default"
        )}
      >
        {row.title}
      </span>
      {row.kind === "pull" && row.since !== null ? (
        <PushedMeta row={row} />
      ) : (
        <span className={cn("text-caption truncate", "text-text-subtle")}>{row.meta}</span>
      )}
    </span>
  </>
);

const ShortRow = ({ row }: { readonly row: QueueRow }) => (
  <>
    <span className="text-text-subtle text-micro w-tree-row shrink-0 text-center font-mono">
      {row.kind === "pull" ? row.number : ""}
    </span>
    <span className="text-body text-text-subtle line-clamp-1 flex-1 text-left">{row.title}</span>
  </>
);

/** A group's header: its label and count; Reviewed's folds the group, closed by default. */
const GroupHeader = ({
  group,
  open,
  onToggle,
}: {
  readonly group: QueueGroup;
  readonly open: boolean;
  readonly onToggle: () => void;
}) => {
  const className = cn(KICKER, "px-gap pt-gap flex items-center gap-1.5 pb-1.5");

  if (group.collapsible !== true) {
    return (
      <h2 className={className}>
        <span>{group.label}</span>
        <span aria-hidden>·</span>
        <span className="tabular">{group.rows.length}</span>
      </h2>
    );
  }

  return (
    <h2 className="flex">
      <button
        type="button"
        aria-expanded={open}
        data-testid="review-queue-fold"
        data-group={group.id}
        onClick={onToggle}
        className={cn(className, "hover:text-text-default flex-1 cursor-default gap-1.5")}
      >
        <DisclosureChevron open={open} className="text-text-faint" />
        <span className="text-left">{group.label}</span>
        <span aria-hidden>·</span>
        <span className="tabular">{group.rows.length}</span>
      </button>
    </h2>
  );
};

/** A pull request's row opens its menu on right-click; an Agent Session's has none. */
const WithMenu = ({
  row,
  children,
}: {
  readonly row: QueueRow;
  readonly children: ReactElement;
}) =>
  row.kind === "pull" && row.url !== "" ? <PullMenu url={row.url}>{children}</PullMenu> : children;

interface RowProps {
  readonly row: QueueRow;
  readonly compact: boolean;
  readonly selected: boolean;
  /** Its ⌃N while Control is held; null past the ninth or in a folded group. */
  readonly digit: number | null;
  readonly mark: RiskMark | null;
  readonly onOpen: (row: QueueRow) => void;
}

const Row = ({ row, compact, selected, digit, mark, onOpen }: RowProps) => (
  <WithMenu row={row}>
    <button
      type="button"
      data-testid="review-queue-row"
      data-row={row.id}
      aria-current={selected ? "page" : undefined}
      onClick={() => onOpen(row)}
      className={cn(
        "rounded-row flex shrink-0 cursor-default items-center gap-row-x border px-gap",
        compact ? "h-row" : "min-h-session-row py-1",
        selected ? "bg-row-selected border-hairline" : "hover:bg-fill-hover border-transparent"
      )}
    >
      {compact ? <ShortRow row={row} /> : <TallRow row={row} selected={selected} />}
      {digit === null ? (
        <Mark mark={mark} />
      ) : (
        <Kbd data-testid="review-queue-digit">{shortcutLabel(digit)}</Kbd>
      )}
    </button>
  </WithMenu>
);

export const Queue = ({
  groups,
  caption,
  selected,
  onOpen,
  onOpenPull,
  onList,
  markOf,
  reviewedOpen,
  onReviewedOpen,
  files,
}: QueueProps) => {
  const held = useCtrlHeld();
  const order = visibleRows(groups, reviewedOpen);

  useDigits(order, onOpen);

  return (
    <nav
      aria-label="Review queue"
      data-testid="review-queue"
      className="flex w-[288px] shrink-0 flex-col pt-2 pr-3 pl-4"
    >
      <button
        type="button"
        onClick={onList}
        aria-label="Pull requests"
        title="All pull requests"
        className="px-gap flex cursor-default flex-col gap-0.5 pb-1.5 text-left"
      >
        <span className="text-title text-text-strong font-semibold">Review</span>
        <span className="text-caption text-text-subtle">{caption}</span>
      </button>
      <div
        className={cn(
          "pb-gap -mx-gap min-h-0 overflow-y-auto",
          files === undefined ? "flex-1" : "max-h-[55%] shrink"
        )}
      >
        {groups.map((group) => {
          const open = group.collapsible !== true || reviewedOpen;

          return (
            <section
              key={group.id}
              data-testid="review-queue-group"
              data-group={group.id}
              className="px-gap flex flex-col gap-0.5"
            >
              <GroupHeader
                group={group}
                open={open}
                onToggle={() => onReviewedOpen(!reviewedOpen)}
              />
              {open &&
                group.rows.map((row) => {
                  const digit = order.indexOf(row);

                  return (
                    <Row
                      key={row.id}
                      row={row}
                      compact={group.compact}
                      selected={row.id === selected}
                      digit={held && digit !== -1 && digit < 9 ? digit : null}
                      mark={markOf(row)}
                      onOpen={onOpen}
                    />
                  );
                })}
            </section>
          );
        })}
      </div>
      {files}
      <div className="gap-gap flex h-12 shrink-0 items-center">
        <ByUrl onOpen={onOpenPull} />
        <span className="flex-1" />
        <span className="text-caption text-text-subtle tabular shrink-0 whitespace-nowrap">
          {shortcutLabel(0)}–9 to jump
        </span>
      </div>
    </nav>
  );
};
