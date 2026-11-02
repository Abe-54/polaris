/**
 * A diff tab's body (DESIGN.md, Editor: diff tabs): the toolbar, then the diff or a calm
 * notice (binary, too large, no changes). F7 / ⇧F7 step through the changes.
 */
import { Button, EmptyState, PixelForkIcon } from "@polaris/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useCommands } from "../../../../shell/hooks.ts";
import { DiffWorkers, useThemeType } from "../../../diffs/index.ts";
import { openFile } from "../../api.ts";
import { basename } from "../../explorer/model/paths.ts";
import type { ComposedDiff } from "../data/compose.ts";
import { syntaxEngine } from "../data/syntax.ts";
import type { DiffTab } from "../data/tabs.ts";
import { type DiffState, useDiff } from "../data/useDiff.ts";
import { MAX_DIFF_LINES, sizeLabel } from "../model/content.ts";
import { setDiffPrefs, useDiffPrefs } from "../model/prefs.ts";
import { type Stop, step, stopsOf } from "../model/stops.ts";
import type { DiffTarget } from "../model/target.ts";
import { DiffToolbar } from "./DiffToolbar.tsx";
import { DiffView, type DiffViewHandle } from "./DiffView.tsx";

export interface DiffTabBodyProps {
  readonly tab: DiffTab;
  readonly root: string;
}

/** One file at a time needs fewer highlighters than Review's thousands (if Review's pool runs, it's shared). */
const EDITOR_POOL_SIZE = 2;

/** "Loading" only after a beat, so a quick read on this Mac never flashes it. */
const LOADING_DELAY_MS = 400;

const useLate = (on: boolean) => {
  const [late, setLate] = useState(false);

  useEffect(() => {
    setLate(false);

    if (!on) return undefined;
    const timer = setTimeout(() => setLate(true), LOADING_DELAY_MS);

    return () => clearTimeout(timer);
  }, [on]);

  return late;
};

/** Why the syntax-aware switch is on but the rows are by line. */
const FALLBACK_NOTE = {
  // The switch itself says when a kind of file has no tokens.
  unsupported: null,
  "too-long": "Too long to match by token: shown by line",
  "no-tokens": "Couldn't read this file's tokens: shown by line",
  "too-complex": "Too many changes to match by token: shown by line",
  failed: "Couldn't match by token: shown by line",
  pending: "Matching by token…",
} as const satisfies Record<NonNullable<ComposedDiff["fallback"]>, string | null>;

const noteOf = (composed: ComposedDiff) => {
  if (composed.spacingOnly) return "Only spacing changed";

  return composed.fallback === null ? null : FALLBACK_NOTE[composed.fallback];
};

const SAME_TEXT = {
  staged: "The index matches HEAD.",
  head: "The working tree matches HEAD.",
  unstaged: "The working tree matches the index.",
} as const satisfies Record<DiffTarget["side"], string>;

const sameText = (target: DiffTarget) => SAME_TEXT[target.side];

const Notice = ({
  state,
  target,
  onOpenFile,
}: {
  readonly state: DiffState;
  readonly target: DiffTarget;
  readonly onOpenFile: (() => void) | null;
}) => {
  const late = useLate(state.kind === "loading");
  const name = basename(target.path);

  const open =
    onOpenFile === null ? undefined : (
      <Button variant="secondary" onClick={onOpenFile}>
        Open file
      </Button>
    );

  const notice = {
    loading: late ? { title: "Reading the diff…", fact: undefined } : null,
    error: {
      title: "Couldn't read the diff",
      fact: state.kind === "error" ? state.message : undefined,
    },
    binary: { title: "Binary file", fact: `${name} isn't text, so there are no lines to compare.` },
    "too-large": {
      title: "Too large to diff",
      fact: `${state.kind === "too-large" ? sizeLabel(state.size) : name}. Diffs stop at 1 MB or ${MAX_DIFF_LINES.toLocaleString("en-US")} lines.`,
    },
    same: { title: "No changes", fact: sameText(target) },
    ready: null,
  }[state.kind];

  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center"
      data-testid="diff-notice"
      data-kind={state.kind}
    >
      {notice === null ? null : (
        <EmptyState
          icon={<PixelForkIcon size={24} className="text-text-strong" />}
          title={notice.title}
          fact={notice.fact}
          action={state.kind === "loading" ? undefined : open}
        />
      )}
    </div>
  );
};

/** Registers F7 / ⇧F7 and Open file while this diff shows. */
const useDiffCommands = (
  stops: ReadonlyArray<Stop>,
  go: (direction: 1 | -1) => void,
  onOpenFile: (() => void) | null
) => {
  const commands = useCommands();

  useEffect(() => {
    return commands.register({
      "diff.nextChange": { run: () => go(1), enabled: () => stops.length > 0 },
      "diff.previousChange": { run: () => go(-1), enabled: () => stops.length > 0 },
      "diff.openFile": { run: () => onOpenFile?.(), enabled: () => onOpenFile !== null },
    });
  }, [commands, stops, go, onOpenFile]);
};

const Body = ({ tab, root }: DiffTabBodyProps) => {
  const { target } = tab;
  const prefs = useDiffPrefs();
  const engine = syntaxEngine(target.path);
  const state = useDiff(target, prefs.syntax && engine !== null);
  const themeType = useThemeType();
  const view = useRef<DiffViewHandle>(null);
  const [at, setAt] = useState(-1);
  const composed = state.kind === "ready" ? state.composed : null;

  const stops = useMemo(
    () => (composed === null ? [] : stopsOf(composed.diff, composed.inserted)),
    [composed]
  );

  useEffect(() => {
    setAt(-1);
  }, [stops]);

  const go = useMemo(
    () => (direction: 1 | -1) => {
      const next = step(stops.length, at, direction);
      const stop = stops[next];

      if (stop === undefined) return;
      setAt(next);
      view.current?.reveal(stop);
    },
    [stops, at]
  );

  const onOpenFile = useMemo(
    () =>
      target.git === "deleted"
        ? null
        : () =>
            openFile({
              hostKey: target.hostKey,
              workspaceId: target.workspaceId,
              path: target.path,
              preview: false,
            }),
    [target]
  );

  useDiffCommands(stops, go, onOpenFile);

  return (
    <>
      <DiffToolbar
        target={target}
        root={root}
        style={prefs.style}
        syntax={prefs.syntax}
        syntaxOff={engine === null ? "Line diff only: no tokens for this kind of file" : null}
        note={composed === null ? null : noteOf(composed)}
        changes={composed === null ? null : stops.length}
        at={at}
        onStep={go}
        onStyle={(style) => setDiffPrefs({ style })}
        onSyntax={(syntax) => setDiffPrefs({ syntax })}
        onOpenFile={onOpenFile}
      />
      {composed === null ? (
        <Notice state={state} target={target} onOpenFile={onOpenFile} />
      ) : (
        <DiffView composed={composed} style={prefs.style} themeType={themeType} handle={view} />
      )}
    </>
  );
};

export const DiffTabBody = (props: DiffTabBodyProps) => (
  <div className="flex min-h-0 flex-1 flex-col" data-testid="diff-tab">
    <DiffWorkers poolSize={EDITOR_POOL_SIZE}>
      <Body key={props.tab.id} {...props} />
    </DiffWorkers>
  </div>
);
