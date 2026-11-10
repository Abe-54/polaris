/**
 * The diff as one flat list of rows for a virtualized list: each file's header, then (when open)
 * its hunks' lines with Risk Findings placed under the line they flag. Lines come from Pierre
 * Diffs' patch parser (`FileDiffMetadata`); nothing here touches React Native.
 */
import type { FileDiffMetadata, Hunk } from "@pierre/diffs";
import { type RiskFinding, SEVERITY_RANK, type Severity } from "@polaris/protocol";
import { alignChange, type Row, type Span } from "../diff/align.ts";
import { fileSeverities, highest, listedFindings, SEVERITIES } from "./model.ts";

export type LineKind = "context" | "add" | "remove";

export interface FileRow {
  readonly kind: "file";
  readonly key: string;
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  readonly open: boolean;
  readonly severities: ReadonlyArray<Severity>;
}

export interface HunkRow {
  readonly kind: "hunk";
  readonly key: string;
  /** `@@ -36,7 +36,8 @@` and the symbol git names. */
  readonly header: string;
}

export interface LineRow {
  readonly kind: "line";
  readonly key: string;
  readonly path: string;
  readonly line: LineKind;
  readonly oldNumber: number | null;
  readonly newNumber: number | null;
  readonly text: string;
  /** Token spans of `text` the change emphasises. */
  readonly emphasis: ReadonlyArray<Span>;
  /** The most severe listed finding covering this line, for the gutter glyph and the 2px rule. */
  readonly mark: Severity | null;
}

export interface FindingRow {
  readonly kind: "finding";
  readonly key: string;
  readonly finding: RiskFinding;
}

/** A line of words in the list: a path the diff doesn't have, or why the diff can't show. */
export interface NoteRow {
  readonly kind: "note";
  readonly key: string;
  readonly text: string;
}

export type DiffRow = FileRow | HunkRow | LineRow | FindingRow | NoteRow;

export interface DiffFileInput {
  readonly diff: FileDiffMetadata;
  readonly added: number;
  readonly removed: number;
}

const trimNewline = (text: string) =>
  text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;

/** `@@ -36,7 +36,8 @@` and the symbol git names, as one line. */
export const hunkHeader = (hunk: Hunk): string => {
  const specs =
    hunk.hunkSpecs ??
    `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@`;

  // Pierre's `hunkSpecs` is the whole `@@` line, the symbol git names included.
  if (hunk.hunkSpecs !== undefined || hunk.hunkContext === undefined) return specs.trim();

  return `${specs.trim()} ${hunk.hunkContext.trim()}`;
};

/** A line of a hunk: its side, numbers, text and the token spans its change emphasises. */
export interface Line {
  readonly line: LineKind;
  readonly oldNumber: number | null;
  readonly newNumber: number | null;
  readonly text: string;
  readonly emphasis: ReadonlyArray<Span>;
}

const NONE: ReadonlyArray<Span> = [];

/** Unchanged lines, or one change: its removed lines, its added ones, and how they pair. */
type Block =
  | { readonly kind: "context"; readonly lines: ReadonlyArray<Line> }
  | {
      readonly kind: "change";
      readonly removed: ReadonlyArray<Line>;
      readonly added: ReadonlyArray<Line>;
      readonly rows: ReadonlyArray<Row>;
    };

const changeBlock = (
  file: FileDiffMetadata,
  content: Extract<Hunk["hunkContent"][number], { type: "change" }>,
  numbers: { old: number; new: number }
): Block => {
  const removedText = Array.from({ length: content.deletions }, (_, i) =>
    trimNewline(file.deletionLines[content.deletionLineIndex + i] ?? "")
  );

  const addedText = Array.from({ length: content.additions }, (_, i) =>
    trimNewline(file.additionLines[content.additionLineIndex + i] ?? "")
  );

  const rows = alignChange(removedText, addedText, file.name);
  const removedSpans = new Map(rows.flatMap((r) => (r.old === null ? [] : [[r.old, r.removed]])));
  const addedSpans = new Map(rows.flatMap((r) => (r.new === null ? [] : [[r.new, r.added]])));
  const { old, new: nu } = numbers;

  numbers.old += content.deletions;
  numbers.new += content.additions;

  return {
    kind: "change",
    rows,
    removed: removedText.map((text, i) => ({
      line: "remove",
      oldNumber: old + i,
      newNumber: null,
      text,
      emphasis: removedSpans.get(i) ?? NONE,
    })),
    added: addedText.map((text, i) => ({
      line: "add",
      oldNumber: null,
      newNumber: nu + i,
      text,
      emphasis: addedSpans.get(i) ?? NONE,
    })),
  };
};

const hunkBlocks = (file: FileDiffMetadata, hunk: Hunk): ReadonlyArray<Block> => {
  const numbers = { old: hunk.deletionStart, new: hunk.additionStart };

  return hunk.hunkContent.map((content): Block => {
    if (content.type === "change") return changeBlock(file, content, numbers);

    const lines = Array.from({ length: content.lines }, (_, i): Line => {
      const text = file.additionLines[content.additionLineIndex + i] ?? "";

      return {
        line: "context",
        oldNumber: numbers.old + i,
        newNumber: numbers.new + i,
        text: trimNewline(text),
        emphasis: NONE,
      };
    });

    numbers.old += content.lines;
    numbers.new += content.lines;

    return { kind: "context", lines };
  });
};

/** A hunk's lines in unified order: context, then each change's deletions before its additions. */
export const hunkLines = (file: FileDiffMetadata, hunk: Hunk): ReadonlyArray<Line> =>
  hunkBlocks(file, hunk).flatMap((block) =>
    block.kind === "context" ? block.lines : [...block.removed, ...block.added]
  );

/** One row of a split diff: the old side's line and the new side's, either missing. */
export interface LinePair {
  readonly old: Line | null;
  readonly new: Line | null;
}

/** A hunk's lines side by side: context on both, a change's lines as the token diff pairs them. */
export const hunkPairs = (file: FileDiffMetadata, hunk: Hunk): ReadonlyArray<LinePair> =>
  hunkBlocks(file, hunk).flatMap((block): ReadonlyArray<LinePair> => {
    if (block.kind === "context") return block.lines.map((line) => ({ old: line, new: line }));

    return block.rows.map((row) => ({
      old: row.old === null ? null : (block.removed[row.old] ?? null),
      new: row.new === null ? null : (block.added[row.new] ?? null),
    }));
  });

/** Whether `finding` flags `line`, on the side its range is on. */
export const covers = (finding: RiskFinding, line: Line): boolean => {
  const number = finding.lines.side === "old" ? line.oldNumber : line.newNumber;

  return number !== null && number >= finding.lines.start && number <= finding.lines.end;
};

/** Whether `line` is the last one `finding` flags: its card goes under it. */
export const anchors = (finding: RiskFinding, line: Line): boolean =>
  (finding.lines.side === "old" ? line.oldNumber : line.newNumber) === finding.lines.end;

const fileRows = (
  input: DiffFileInput,
  findings: ReadonlyArray<RiskFinding>,
  open: boolean
): ReadonlyArray<DiffRow> => {
  const path = input.diff.name;

  const header: FileRow = {
    kind: "file",
    key: `f:${path}`,
    path,
    added: input.added,
    removed: input.removed,
    open,
    severities: fileSeverities(findings, path),
  };

  const mine = listedFindings(findings).filter((f) => f.path === path);

  // Closing a file never hides a Critical finding: its card stays under the header.
  if (!open)
    return [
      header,
      ...mine
        .filter((f) => f.severity === "critical")
        .map((finding): FindingRow => ({ kind: "finding", key: `r:${finding.id}`, finding })),
    ];

  const placed = new Set<string>();
  const rows: Array<DiffRow> = [header];

  input.diff.hunks.forEach((hunk, h) => {
    rows.push({ kind: "hunk", key: `h:${path}:${h}`, header: hunkHeader(hunk) });

    for (const [i, line] of hunkLines(input.diff, hunk).entries()) {
      const covering = mine.filter((f) => covers(f, line));
      rows.push({
        kind: "line",
        key: `l:${path}:${h}:${i}`,
        path,
        ...line,
        mark: highest(covering.map((f) => f.severity)),
      });

      for (const finding of mine) {
        if (placed.has(finding.id) || !anchors(finding, line)) continue;
        placed.add(finding.id);
        rows.push({ kind: "finding", key: `r:${finding.id}`, finding });
      }
    }
  });

  // A finding whose line the diff doesn't show still shows, under the file's header.
  const unplaced = mine
    .filter((f) => !placed.has(f.id))
    .map((finding): FindingRow => ({ kind: "finding", key: `r:${finding.id}`, finding }));

  return [header, ...unplaced, ...rows.slice(1)];
};

/** Which files open first: any with an open Critical finding, else the first file. */
export const defaultOpen = (
  files: ReadonlyArray<DiffFileInput>,
  findings: ReadonlyArray<RiskFinding>
): ReadonlySet<string> => {
  const critical = new Set(
    findings.flatMap((f) => (f.severity === "critical" && f.status === "open" ? [f.path] : []))
  );

  const open = files.flatMap((f) => (critical.has(f.diff.name) ? [f.diff.name] : []));
  const first = files[0];

  return new Set(open.length > 0 || first === undefined ? open : [first.diff.name]);
};

export type FileOrder = "risk" | "path";

/** Files by their most severe finding (then patch order), or in patch order. */
export const orderFiles = (
  files: ReadonlyArray<DiffFileInput>,
  findings: ReadonlyArray<RiskFinding>,
  order: FileOrder
): ReadonlyArray<DiffFileInput> => {
  if (order === "path") return files;

  const rank = (file: DiffFileInput) => {
    const top = highest(fileSeverities(findings, file.diff.name));

    return top === null ? SEVERITIES.length : SEVERITY_RANK[top];
  };

  return [...files].sort((a, b) => rank(a) - rank(b));
};

/** Listed findings on paths the patch doesn't have, under each path: nothing hides a Critical. */
const absentRows = (
  files: ReadonlyArray<DiffFileInput>,
  findings: ReadonlyArray<RiskFinding>
): ReadonlyArray<DiffRow> => {
  const present = new Set(files.map((f) => f.diff.name));
  const absent = listedFindings(findings).filter((f) => !present.has(f.path));
  const paths = [...new Set(absent.map((f) => f.path))];

  return paths.flatMap((path) => [
    { kind: "note", key: `n:${path}`, text: path } satisfies NoteRow,
    ...absent
      .filter((f) => f.path === path)
      .map((finding): FindingRow => ({ kind: "finding", key: `r:${finding.id}`, finding })),
  ]);
};

export const diffRows = (
  files: ReadonlyArray<DiffFileInput>,
  findings: ReadonlyArray<RiskFinding>,
  open: ReadonlySet<string>
): ReadonlyArray<DiffRow> => [
  ...absentRows(files, findings),
  ...files.flatMap((f) => fileRows(f, findings, open.has(f.diff.name))),
];

/** Review's list: the diff's rows, or why the diff can't show above every listed finding. */
export const reviewRows = (input: {
  readonly files: ReadonlyArray<DiffFileInput>;
  readonly problem: string | null;
  readonly findings: ReadonlyArray<RiskFinding>;
  readonly open: ReadonlySet<string>;
  readonly order: FileOrder;
}): ReadonlyArray<DiffRow> =>
  input.problem === null
    ? diffRows(orderFiles(input.files, input.findings, input.order), input.findings, input.open)
    : [
        { kind: "note", key: "n:problem", text: input.problem },
        ...diffRows([], input.findings, input.open),
      ];

/** Every line of one file, open or not: what "Ask to fix" quotes from. */
export const fileLines = (
  files: ReadonlyArray<DiffFileInput>,
  path: string
): ReadonlyArray<LineRow> =>
  diffRows(
    files.filter((f) => f.diff.name === path),
    [],
    new Set([path])
  ).filter((row): row is LineRow => row.kind === "line");
