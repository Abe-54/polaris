/**
 * Output for one Agent Session (artboard 5's Changes tab): the chosen Turn's diff (every
 * Turn the Harness started in it included) as file cards, virtualized by line. A light
 * unified renderer: code coloured by the syntax tokens from Pierre's worker pool
 * (useDiffSyntax.ts), drawn plain until ready; no word highlights, which stay in Review.
 * A chosen Subagent adds its tab after Changes (`SubagentOutput.tsx`) and shows in place.
 */
import {
  Button,
  ChevronDownIcon,
  ChevronRightIcon,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  PixelSparkleIcon,
} from "@polaris/ui";
import { isKnownHarness } from "@polaris/protocol";
import { useVirtualizer } from "@tanstack/react-virtual";
import { lazy, type ReactNode, Suspense, useMemo, useRef, useState } from "react";
import { type DiffRow, diffRows, ROW_HEIGHT } from "../diffRows.ts";
import { type DiffSyntax, lineSyntax } from "../diffSyntax.ts";
import { useSession } from "../hooks.ts";
import { useDiffSyntax } from "../useDiffSyntax.ts";
import { LineCode } from "./LineCode.tsx";
import { turnOpening } from "../model/conversation.ts";
import {
  groupOf,
  groupSpan,
  groupTurns,
  openingView,
  type TurnGroup,
} from "../model/turnGroups.ts";
import { type DiffFile, firstChangedLine, totals } from "../model/diff.ts";
import { plural } from "../model/format.ts";
import { showSubagent, showTurnDiff, uiKey, useSessionUi } from "../state.ts";
import { type DiffState, spanRevision, useTurnDiff } from "../turnDiff.ts";
import { hideOutput } from "../output/actions.ts";
import { showHint } from "../output/OutputRail.tsx";
import { useFilesTick } from "../output/watch.ts";
import type { SessionViewProps } from "./SessionIntent.tsx";
import { OutputTab, SubagentPane, SubagentTab, useShownSubagent } from "./SubagentOutput.tsx";
import { EditorPlaceProvider, OpenInEditorButton } from "../../editor-links/index.ts";
import { leaveBrowser } from "../output/browser.ts";
import { BrowserOutputTab, SessionBrowser, useBrowserShown } from "./BrowserOutput.tsx";
import { useSettings } from "../../settings/index.ts";

const CARD = "mx-4 border-x border-hairline bg-surface-sunken";

const LINE_FILL = { add: "bg-diff-added-bg", remove: "bg-diff-removed-bg", context: "" } as const;

const SIGN = { add: "+", remove: "−", context: "" } as const;

/** Output highlights one Turn's hunks: the editor's diff tabs' pool size, shared if one runs. */
const OUTPUT_POOL_SIZE = 2;

const Counts = ({ added, removed }: { readonly added: number; readonly removed: number }) => (
  <>
    <span className="text-code-inline text-diff-added-text tabular font-mono">+{added}</span>
    <span className="text-code-inline text-diff-removed-text tabular font-mono">−{removed}</span>
  </>
);

interface RowViewProps {
  readonly row: DiffRow;
  readonly path: string;
  readonly syntax: DiffSyntax;
  readonly wrap: boolean;
  readonly onFold: (path: string) => void;
}

const RowView = ({ row, path, syntax, wrap, onFold }: RowViewProps) => {
  switch (row.kind) {
    case "file":
      return (
        <div
          className={cn(
            CARD,
            "rounded-t-row group/file flex h-9 w-[calc(100%-2rem)] items-center border-t pr-1.5",
            row.folded ? "rounded-b-row border-b" : "border-hairline border-b"
          )}
        >
          <button
            type="button"
            onClick={() => onFold(row.file.path)}
            aria-expanded={!row.folded}
            className="flex h-full min-w-0 flex-1 cursor-default items-center gap-2.5 px-3 text-left"
            data-testid="diff-file"
          >
            {row.folded ? (
              <ChevronRightIcon size={12} className="text-text-subtle" />
            ) : (
              <ChevronDownIcon size={12} className="text-text-subtle" />
            )}
            <span className="text-code-inline text-text-default truncate font-mono">
              {row.file.oldPath === null ? row.file.path : `${row.file.oldPath} → ${row.file.path}`}
            </span>
            <Counts added={row.file.added} removed={row.file.removed} />
            <span className="flex-1" />
            {row.file.status === "modified" ? null : (
              <span className="text-caption text-text-subtle">{row.file.status}</span>
            )}
          </button>
          {row.file.status === "deleted" ? null : (
            <OpenInEditorButton
              path={row.file.path}
              line={firstChangedLine(row.file)}
              className="opacity-0 group-hover/file:opacity-100 focus-visible:opacity-100"
            />
          )}
        </div>
      );
    case "hunk":
      return (
        <div
          className={cn(
            CARD,
            "text-code-inline text-text-subtle flex h-6 items-center truncate px-3 font-mono"
          )}
        >
          {row.header}
        </div>
      );
    case "line":
      return (
        <div
          className={cn(
            CARD,
            "text-code-inline flex font-mono leading-5",
            wrap ? "min-h-5 items-start" : "h-5 items-center",
            LINE_FILL[row.line.kind]
          )}
        >
          <span className="text-text-subtle tabular w-[42px] shrink-0 pr-2 text-right">
            {row.line.newNumber ?? ""}
          </span>
          <span
            className={cn(
              "w-[22px] shrink-0 text-center",
              row.line.kind === "add" ? "text-diff-added-text" : "text-diff-removed-text"
            )}
          >
            {SIGN[row.line.kind]}
          </span>
          <LineCode text={row.line.text} runs={lineSyntax(syntax, path, row.line)} wrap={wrap} />
        </div>
      );
    case "note":
      return (
        <div className={cn(CARD, "text-caption text-text-subtle flex h-7 items-center px-3")}>
          {row.text}
        </div>
      );
    case "foot":
      return <div className={cn(CARD, "rounded-b-row h-1.5 border-b")} />;
    case "gap":
      return <div className="h-3" />;
  }
};

/** Each row's file path: a line row's colours are looked up by it. */
const rowPaths = (rows: ReadonlyArray<DiffRow>) => {
  let path = "";

  return rows.map((row) => {
    if (row.kind === "file") path = row.file.path;

    return path;
  });
};

interface DiffListProps {
  readonly files: ReadonlyArray<DiffFile>;
  readonly folded: ReadonlySet<string>;
  readonly onFold: (path: string) => void;
}

const DiffList = ({ files, folded, onFold }: DiffListProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => diffRows(files, folded), [files, folded]);
  const paths = useMemo(() => rowPaths(rows), [rows]);
  const syntax = useDiffSyntax(files);
  const wrap = useSettings((s) => s.appearance.wordWrap);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => ROW_HEIGHT[rows[index]?.kind ?? "line"],
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 24,
    paddingStart: 16,
    paddingEnd: 16,
    directDomUpdates: true,
  });

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto select-text" data-testid="diff">
      <div ref={virtualizer.containerRef} className="relative w-full">
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];

          return row === undefined ? null : (
            <div
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className="absolute top-0 left-0 w-full"
            >
              <RowView
                row={row}
                path={paths[item.index] ?? ""}
                syntax={syntax}
                wrap={wrap}
                onFold={onFold}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};

// Lazy, as Review and the editor's diff tab are: the pool's `?worker` import only loads under Vite.
const DiffWorkers = lazy(() =>
  import("../../diffs/workers.tsx").then((m) => ({ default: m.DiffWorkers }))
);

/** A Turn's files as the Changes tab draws them, highlighted in the diffs' worker pool. */
export const TurnChanges = (props: DiffListProps) => (
  <Suspense fallback={<DiffList {...props} />}>
    <DiffWorkers poolSize={OUTPUT_POOL_SIZE}>
      <DiffList {...props} />
    </DiffWorkers>
  </Suspense>
);

/** One entry per shown Turn; its diff covers the Turns the Harness started in it. */
const TurnMenu = ({
  groups,
  current,
  onPick,
}: {
  readonly groups: ReadonlyArray<TurnGroup>;
  readonly current: TurnGroup;
  readonly onPick: (turnId: string) => void;
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" size="sm" data-testid="diff-turn">
        Turn {current.number}
        <ChevronDownIcon size={10} />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuRadioGroup value={current.id} onValueChange={onPick}>
        {groups.toReversed().map((g) => (
          <DropdownMenuRadioItem key={g.id} value={g.id}>
            <span className="tabular">Turn {g.number}</span>
            <span className="text-caption text-text-subtle max-w-56 truncate pl-3">
              {turnOpening(openingView(g).turn)}
            </span>
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>
);

const errorText = (state: Extract<DiffState, { kind: "error" }>) => {
  if (/repositor/i.test(state.message)) return "This workspace isn't a git repository";

  if (state.code === "NotFound") return "This turn has no checkpoint yet";

  return state.message;
};

const Empty = ({ title, fact }: { title: string; fact?: string }) => (
  <div className="grid flex-1 place-items-center" data-testid="diff-empty">
    {/* The pane tier (Paper 5SH-1): a Starlight tile with the pixel sparkle, never blank. */}
    <EmptyState
      icon={<PixelSparkleIcon size={24} className="text-text-strong" />}
      title={title}
      fact={fact}
    />
  </div>
);

const Body = ({
  state,
  folded,
  onFold,
}: {
  state: DiffState;
  folded: ReadonlySet<string>;
  onFold: (path: string) => void;
}) => {
  switch (state.kind) {
    case "loading":
      return <div className="flex-1" />;
    case "error":
      return <Empty title="No diff to show" fact={errorText(state)} />;
    case "too-large":
      return (
        <Empty
          title="This diff is too large to show here"
          fact={`${Math.round(state.bytes / 1024)} KB · open it in review`}
        />
      );
    case "ready":
      return state.files.length === 0 ? (
        <Empty title="This turn changed no files" />
      ) : (
        <TurnChanges files={state.files} folded={folded} onFold={onFold} />
      );
  }
};

/** The Changes tab's body: the chosen Turn's diff, or why there is none. */
const Changes = ({
  current,
  ...body
}: {
  readonly current: TurnGroup | null;
  readonly state: DiffState;
  readonly folded: ReadonlySet<string>;
  readonly onFold: (path: string) => void;
}) =>
  current === null ? (
    <Empty title="No changes yet" fact="Each turn's diff shows here" />
  ) : (
    <Body {...body} />
  );

export interface SessionOutputProps extends SessionViewProps {
  /** Tabs in place of the lone Changes label (a Lead's Constellation tab). */
  readonly tabs?: ReactNode;
}

/** The header's diff controls: which Turn, and its file and line counts. */
const DiffSummary = ({
  groups,
  current,
  state,
  onPick,
}: {
  readonly groups: ReadonlyArray<TurnGroup>;
  readonly current: TurnGroup | null;
  readonly state: DiffState;
  readonly onPick: (turnId: string) => void;
}) => {
  const sum = state.kind === "ready" ? totals(state.files) : null;

  return (
    <>
      {current === null ? null : <TurnMenu groups={groups} current={current} onPick={onPick} />}
      {sum === null ? null : (
        <>
          <span className="text-caption text-text-subtle tabular">
            · {plural(sum.files, "file")}
          </span>
          <Counts added={sum.added} removed={sum.removed} />
        </>
      )}
    </>
  );
};

export const SessionOutput = ({ hostKey, sessionId, tabs }: SessionOutputProps) => {
  const model = useSession(hostKey, sessionId);
  const key = uiKey(hostKey, sessionId);
  const ui = useSessionUi(key);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const subagent = useShownSubagent(hostKey, sessionId);
  const browser = useBrowserShown(hostKey, sessionId, subagent !== null);

  const groups = groupTurns(model.turns);
  const current = groupOf(groups, ui.diffTurnId) ?? groups.at(-1) ?? null;

  const session = model.session;
  const cwd = session?.cwd ?? null;
  const files = useFilesTick(hostKey, cwd);
  const harness = session !== null && isKnownHarness(session.harness) ? session.harness : null;

  const state = useTurnDiff(
    hostKey,
    cwd ?? "",
    sessionId,
    current === null || subagent !== null || browser ? null : groupSpan(current),
    current === null ? "" : spanRevision(current.views, files)
  );

  const close = () => showSubagent(key, null);

  const changes = () => {
    close();
    leaveBrowser(hostKey, sessionId);
  };

  const fold = (path: string) => {
    const next = new Set(folded);

    if (!next.delete(path)) next.add(path);
    setFolded(next);
  };

  const place =
    session === null ? null : { hostKey, root: session.cwd, workspaceId: session.workspaceId };

  return (
    <EditorPlaceProvider value={place}>
      <section
        aria-label="Output"
        className="bg-panel flex h-full min-h-0 min-w-0 flex-col"
        data-testid="session-output"
      >
        <div className="border-hairline flex h-11 shrink-0 items-center gap-1 border-b px-3">
          {tabs ?? (
            <OutputTab id="changes" on={subagent === null && !browser} onClick={changes}>
              Changes
            </OutputTab>
          )}
          <BrowserOutputTab
            hostKey={hostKey}
            sessionId={sessionId}
            on={browser}
            harness={harness}
          />
          {subagent === null ? null : (
            <SubagentTab shown={subagent} harness={harness} onClose={close} />
          )}
          <span className="flex-1" />
          {subagent === null && !browser ? (
            <DiffSummary
              groups={groups}
              current={current}
              state={state}
              onPick={(id) => showTurnDiff(key, id)}
            />
          ) : null}
          {session === null ? null : (
            <IconButton
              size="sm"
              label="Hide output"
              shortcut={showHint()}
              icon={<ChevronRightIcon size={14} />}
              onClick={() => hideOutput({ hostKey, workspaceId: session.workspaceId }, sessionId)}
            />
          )}
        </div>
        {browser && session !== null ? (
          <SessionBrowser
            hostKey={hostKey}
            sessionId={sessionId}
            workspaceId={session.workspaceId}
            harness={harness}
          />
        ) : subagent === null ? (
          <Changes current={current} state={state} folded={folded} onFold={fold} />
        ) : (
          <SubagentPane
            shown={subagent}
            harness={harness}
            target={{ hostKey, sessionId }}
            onClose={close}
            onOpenDiff={() => {
              showTurnDiff(key, subagent.card.subagent.turnId);
              close();
            }}
          />
        )}
      </section>
    </EditorPlaceProvider>
  );
};
