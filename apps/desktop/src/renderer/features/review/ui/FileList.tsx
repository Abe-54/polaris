/**
 * The file list under the risk column (Paper R1 1XP-0, R11): Viewed progress and the
 * Intent / Path switch, then either a row per file (viewed files fold into one row,
 * generated files into another) or the files by group. Virtualized, since a list-only
 * Review can hold tens of thousands of files.
 */
import { SegmentedControl } from "@polaris/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef, useState } from "react";
import type { ListGrouping } from "../data/groupingStore.ts";
import { type FileListRow, fileListRows, type Fold, type TestsFold } from "../model/fileList.ts";
import type { Grouping } from "../model/groups.ts";
import type { ReviewFile } from "../model/layout.ts";
import type { MarkSeverity } from "../model/marks.ts";
import type { ViewedProgress } from "../model/viewed.ts";
import { FileRow, FoldRow } from "./FileRows.tsx";
import { GroupList } from "./GroupList.tsx";
import { DataRow } from "../schema/DataRows.tsx";
import { type DataListRow, isDataRow, isMigrationPath, placeData } from "../schema/model.ts";

/** The Data section (DESIGN.md, Data → In Review): its rows, and the source the pane shows. */
export interface FileListData {
  readonly rows: ReadonlyArray<DataListRow>;
  readonly open: string | null;
  readonly onOpen: (sourceId: string) => void;
}

export interface FileListProps {
  readonly files: ReadonlyArray<ReviewFile>;
  readonly viewedOf: (file: ReviewFile) => boolean;
  /** Viewed, then changed: the row says so. */
  readonly changedOf: (file: ReviewFile) => boolean;
  readonly severities: ReadonlyMap<string, MarkSeverity>;
  readonly progress: ViewedProgress;
  readonly current: string | null;
  readonly notice: string | null;
  readonly onOpen: (key: string) => void;
  readonly onViewed: (key: string, viewed: boolean) => void;
  /** "Hide tests": null when the Review has no test file it could hide. */
  readonly tests: TestsFold | null;
  readonly onTestsHidden: (hidden: boolean) => void;
  /** The files' groups: the Walkthrough's, or by path before it has any. */
  readonly grouping: Grouping;
  readonly mode: ListGrouping;
  readonly onMode: (mode: ListGrouping) => void;
  /** An Agent Session's Data section; null for a pull request or a Daemon without it. */
  readonly data: FileListData | null;
}

type FlatRow = FileListRow | DataListRow;

const isMigrationRow = (row: FlatRow) => row.kind === "file" && isMigrationPath(row.file.file.path);

const ROW_HEIGHT = 28;

const MODES = [
  { value: "intent", label: "Intent" },
  { value: "path", label: "Path" },
] as const;

const FlatList = ({ props }: { readonly props: FileListProps }) => {
  const [open, setOpen] = useState<ReadonlySet<Fold>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = placeData<FlatRow>(
    fileListRows(props.files, props.viewedOf, open, props.tests),
    props.data?.rows ?? [],
    isMigrationRow,
    (row) => row.kind === "fold"
  );

  const toggle = (fold: Fold) =>
    fold === "tests"
      ? props.onTestsHidden(props.tests?.hidden !== true)
      : setOpen((now) => {
          const next = new Set(now);

          if (!next.delete(fold)) next.add(fold);

          return next;
        });

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => {
      const row = rows[index];

      if (row === undefined) return index;

      if (isDataRow(row)) return row.key;

      return row.kind === "fold" ? `fold:${row.fold}` : row.file.key;
    },
    overscan: 12,
  });

  const render = (row: FlatRow) => {
    if (isDataRow(row))
      return props.data === null ? null : (
        <DataRow row={row} open={props.data.open} onOpen={props.data.onOpen} />
      );

    return row.kind === "fold" ? (
      <FoldRow row={row} onToggle={toggle} />
    ) : (
      <FileRow
        file={row.file}
        viewed={row.viewed}
        changed={props.changedOf(row.file)}
        severity={props.severities.get(row.file.file.path)}
        current={props.current === row.file.key}
        onOpen={props.onOpen}
        onViewed={props.onViewed}
      />
    );
  };

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pb-24">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];

          return row === undefined ? null : (
            <div
              key={item.key}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {render(row)}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const FileList = (props: FileListProps) => (
  <section data-testid="review-files" className="px-gap pt-panel flex min-h-0 flex-1 flex-col">
    <div className="gap-row-x px-gap pb-gap flex items-center">
      <span className="text-caption text-text-subtle">Files</span>
      <span className="bg-surface-sunken flex h-1 flex-1 rounded-full">
        <span
          className="bg-text-subtle h-1 rounded-full"
          style={{ width: `${Math.round(props.progress.fraction * 100)}%` }}
        />
      </span>
      <span className="text-caption text-text-subtle tabular" data-testid="review-progress">
        {props.progress.label}
      </span>
      <SegmentedControl
        aria-label="Group files"
        variant="well"
        options={MODES}
        value={props.mode}
        onValueChange={props.onMode}
      />
    </div>
    {props.notice !== null && (
      <p className="text-caption text-text-subtle px-gap pb-gap" data-testid="review-scale">
        {props.notice}
      </p>
    )}
    {props.mode === "intent" && props.grouping.source === "path" && (
      <p
        className="text-caption text-text-subtle px-gap pb-gap"
        data-testid="review-grouped-by-path"
      >
        Grouped by path · write a walkthrough to group by intent
      </p>
    )}
    {props.mode === "intent" ? (
      <GroupList
        groups={props.grouping.groups}
        viewedOf={props.viewedOf}
        changedOf={props.changedOf}
        severities={props.severities}
        current={props.current}
        onOpen={props.onOpen}
        onViewed={props.onViewed}
        data={props.data}
      />
    ) : (
      <FlatList props={props} />
    )}
    {props.mode === "intent" && props.tests !== null && (
      <FoldRow
        row={{ fold: "tests", count: props.tests.count, open: !props.tests.hidden }}
        onToggle={() => props.onTestsHidden(props.tests?.hidden !== true)}
      />
    )}
  </section>
);
