/**
 * The rail column (DESIGN.md, Constellation (DAG) → Tree): the trunk, `git log --graph`
 * elbows per depth, the lines of ancestors that run on past a row, and a fold chevron.
 */
import { cn } from "@polaris/ui";
import type { CSSProperties, ReactNode } from "react";
import { railCap, railX, type TreeLane } from "../model/index.ts";

const LINE = "absolute w-px";

/** The glyph's centre, from the row's top (the first line of a `tree-row`). */
const MID = 14;

export interface RailProps {
  readonly tree: TreeLane;
  /** The view's step (`railStep`). */
  readonly step: number;
  readonly accepted?: boolean;
  readonly trail?: ReactNode;
  /** A Subagent's smaller glyph. */
  readonly small?: boolean;
  readonly children: ReactNode;
}

const Lines = ({
  tree,
  step,
  accepted,
}: {
  readonly tree: TreeLane;
  readonly step: number;
  readonly accepted: boolean;
}) => {
  const cap = railCap(step);
  const { depth } = tree;
  const tone = accepted ? "bg-accepted/40" : "bg-text-strong/14";
  const own = depth - 1;

  return (
    <>
      <span
        className={cn(LINE, "bg-text-strong/14 top-0 bottom-0")}
        style={{ left: railX(0, step) }}
      />
      {tree.through.map((runs, n) =>
        runs && n + 1 <= cap && n + 1 < own ? (
          <span
            key={n}
            className={cn(LINE, "bg-text-strong/14 top-0 bottom-0")}
            style={{ left: railX(n + 1, step) }}
          />
        ) : null
      )}
      {own >= 1 && own <= cap && !tree.last ? (
        <span
          className={cn(LINE, "bg-text-strong/14 top-0 bottom-0")}
          style={{ left: railX(own, step) }}
        />
      ) : null}
      {depth >= 1 ? (
        <span
          className={cn(
            "absolute top-0 rounded-bl-[6px] border-b border-l",
            accepted ? "border-accepted/40" : "border-text-strong/14"
          )}
          style={{
            left: railX(own, step),
            width: Math.max(2, railX(depth, step) - railX(own, step) - 5),
            height: MID,
          }}
        />
      ) : null}
      {tree.down ? (
        <span
          className={cn(LINE, tone, "bottom-0")}
          style={{ left: railX(depth, step), top: MID }}
        />
      ) : null}
    </>
  );
};

/** The rail column: lines, the glyph on its depth's column, and a group's or parent's chevron. */
export const Rail = ({
  tree,
  step,
  accepted = false,
  trail,
  small = false,
  children,
}: RailProps) => {
  const size = small ? 12 : 16;
  const x = railX(tree.depth, step);

  const slot: CSSProperties = {
    left: x - size / 2 + 1,
    top: MID - size / 2,
    width: size,
    height: size,
  };

  return (
    <span className="relative w-[60px] shrink-0 self-stretch">
      <Lines tree={tree} step={step} accepted={accepted} />
      <span className="absolute grid place-items-center" style={slot}>
        <span className="bg-panel absolute size-3 rounded-full" />
        <span className="relative grid place-items-center">{children}</span>
      </span>
      {trail === undefined ? null : (
        <span className="absolute top-[6px] right-1 grid size-4 place-items-center">{trail}</span>
      )}
    </span>
  );
};

/** Nested rows indent their content 1.25rem per level below a group's, so the tree reads. */
export const depthIndent = (depth: number): CSSProperties | undefined =>
  depth > 1 ? { paddingLeft: `${(depth - 1) * 1.25}rem` } : undefined;
