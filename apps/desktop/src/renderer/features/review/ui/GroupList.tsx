/**
 * The file list grouped by intent or by path (Paper R11): a row per group (chevron, neutral
 * glyph, label, Critical badge, "1 of 3", highest Severity); an open group adds its "why"
 * and its files. The first group opens by default. Virtualized like the flat list.
 */
import { DisclosureChevron, SeverityBadge, SeverityGlyph } from "@polaris/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef, useState } from "react";
import { type GroupHead, type GroupListRow, groupListRows } from "../model/groupList.ts";
import type { FileGroup } from "../model/groups.ts";
import type { ReviewFile } from "../model/layout.ts";
import type { MarkSeverity } from "../model/marks.ts";
import { FileRow } from "./FileRows.tsx";
import { IntentGlyph } from "./IntentGlyph.tsx";
import { isMigrationPath, placeData } from "../schema/model.ts";
import type { FileListTraces } from "../traces/section.ts";
import type { FileListData } from "./FileList.tsx";
import { isSectionRow, SectionRow, type SectionListRow, sectionRows } from "./SectionRow.tsx";

export interface GroupListProps {
  readonly groups: ReadonlyArray<FileGroup>;
  readonly viewedOf: (file: ReviewFile) => boolean;
  readonly changedOf: (file: ReviewFile) => boolean;
  readonly severities: ReadonlyMap<string, MarkSeverity>;
  readonly current: string | null;
  readonly onOpen: (key: string) => void;
  readonly onViewed: (key: string, viewed: boolean) => void;
  readonly data: FileListData | null;
  readonly traces: FileListTraces | null;
}

type Row = GroupListRow | SectionListRow;

/** A migration's row, or a folded group holding one: the Data section follows it. */
const isMigrationRow = (row: Row) => {
  if (row.kind === "file") return isMigrationPath(row.file.file.path);

  return row.kind === "group" && row.head.group.files.some((f) => isMigrationPath(f.file.path));
};

const ROW_HEIGHT = 28;

const GroupRow = ({
  head,
  onToggle,
}: {
  readonly head: GroupHead;
  readonly onToggle: (key: string) => void;
}) => {
  return (
    <button
      type="button"
      onClick={() => onToggle(head.group.key)}
      aria-expanded={head.open}
      data-testid="review-group"
      data-group={head.group.key}
      title={head.group.summary ?? undefined}
      className="rounded-row hover:bg-fill-hover h-tree-row px-gap flex w-full cursor-default items-center gap-2"
    >
      <DisclosureChevron open={head.open} className="text-text-faint" />
      <IntentGlyph category={head.group.category} />
      <span
        className={`text-body min-w-0 truncate text-left ${head.open ? "text-text-strong" : "text-text-default"}`}
      >
        {head.group.label}
      </span>
      {head.group.critical && <SeverityBadge severity="critical" />}
      <span className="flex-1" />
      <span className="text-caption text-text-subtle tabular shrink-0">{head.count}</span>
      <span className="flex w-3 shrink-0 justify-center">
        {head.severity !== null && <SeverityGlyph severity={head.severity} tone="text" />}
      </span>
    </button>
  );
};

const keyOf = (row: Row | undefined) => {
  if (row === undefined) return "none";

  if (isSectionRow(row)) return row.key;

  if (row.kind === "group") return `group:${row.head.group.key}`;

  return row.kind === "summary" ? `summary:${row.key}` : row.file.key;
};

export const GroupList = (props: GroupListProps) => {
  const [first] = props.groups;
  // Null until the user opens or closes a group: the first group, whichever it is now.
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null);
  const open = chosen ?? new Set(first === undefined ? [] : [first.key]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = placeData<Row>(
    groupListRows(props.groups, props.viewedOf, props.severities, open),
    sectionRows(props.data, props.traces),
    isMigrationRow
  );

  const toggle = (key: string) =>
    setChosen(() => {
      const next = new Set(open);

      if (!next.delete(key)) next.add(key);

      return next;
    });

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => keyOf(rows[index]),
    overscan: 12,
  });

  const render = (row: Row) => {
    if (isSectionRow(row)) return <SectionRow row={row} data={props.data} traces={props.traces} />;

    if (row.kind === "group") return <GroupRow head={row.head} onToggle={toggle} />;

    if (row.kind === "summary")
      return (
        <p
          className="text-caption text-text-subtle pr-gap pb-1 pl-[48px]"
          data-testid="review-group-summary"
        >
          {row.text}
        </p>
      );

    return (
      <FileRow
        file={row.file}
        viewed={row.viewed}
        changed={props.changedOf(row.file)}
        severity={props.severities.get(row.file.file.path)}
        current={props.current === row.file.key}
        nested
        onOpen={props.onOpen}
        onViewed={props.onViewed}
      />
    );
  };

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto pb-24"
      data-testid="review-groups"
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];

          return row === undefined ? null : (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
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
