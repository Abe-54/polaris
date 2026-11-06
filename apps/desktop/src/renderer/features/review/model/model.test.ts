import { describe, expect, test } from "bun:test";
import { fileListRows, reviewProgress } from "./fileList.ts";
import { layoutRows, type LayoutInput, type ReviewFile, type ReviewSection } from "./layout.ts";
import {
  hunkLabel,
  itemKey,
  type LineMark,
  marksCss,
  MAX_MARKED_LINES,
  selectionCss,
} from "./marks.ts";
import { fileText, fingerprint, indexPatch, type PatchFile } from "./patch.ts";
import { paneState } from "./paneState.ts";
import { scaleNotice, scaleOf } from "./policy.ts";
import {
  emptyBook,
  isViewed,
  KEPT_SUBJECTS,
  localViewed,
  progressOf,
  pullFileViewed,
  setViewed,
} from "./viewed.ts";

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 one
-two
+TWO
+three
 four
diff --git a/old.ts b/new.ts
similarity 90%
rename from old.ts
rename to new.ts
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 3333333..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-x
--- not a header
diff --git a/img.png b/img.png
new file mode 100644
index 0000000..4444444
Binary files /dev/null and b/img.png differ
diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`;

const bytes = new TextEncoder().encode(PATCH);

/** The `i`th file of a patch the test wrote, which has it. */
const at = (files: ReadonlyArray<PatchFile>, i: number): PatchFile => {
  const file = files[i];

  if (file === undefined) throw new Error(`no file ${i}`);

  return file;
};

describe("indexPatch", () => {
  test("finds every file, its status and counts without a fileIndex", () => {
    const files = indexPatch(bytes, []);

    expect(
      files.map((f) => [f.path, f.oldPath, f.status, f.additions, f.deletions, f.binary])
    ).toEqual([
      ["src/a.ts", null, "modified", 2, 1, false],
      ["new.ts", "old.ts", "renamed", 0, 0, false],
      ["gone.ts", null, "deleted", 0, 2, false],
      ["img.png", null, "added", 0, 0, true],
      ["run.sh", null, "mode-changed", 0, 0, false],
    ]);
    expect(files.reduce((sum, f) => sum + f.length, 0)).toBe(bytes.length);
    expect(fileText(bytes, at(files, 0)).startsWith("diff --git a/src/a.ts")).toBe(true);
    expect(fileText(bytes, at(files, 0))).toContain(" four\n");
  });

  test("takes the Daemon's fileIndex as it is", () => {
    const index = [
      {
        path: "x",
        oldPath: null,
        status: "added" as const,
        offset: 0,
        length: 3,
        additions: 1,
        deletions: 0,
        binary: false,
        generated: null,
      },
    ];

    expect(indexPatch(bytes, index)).toBe(index);
  });

  test("a fingerprint changes with the file's bytes only", () => {
    const before = indexPatch(bytes, []);
    const changed = new TextEncoder().encode(PATCH.replace("+three", "+THREE"));
    const after = indexPatch(changed, []);

    expect(fingerprint(bytes, at(before, 0))).not.toBe(fingerprint(changed, at(after, 0)));
    expect(fingerprint(bytes, at(before, 1))).toBe(fingerprint(changed, at(after, 1)));
  });
});

describe("scaleOf", () => {
  test.each([
    [10, 1000, "full"],
    [2000, 1000, "full"],
    [2001, 1000, "collapsed"],
    [10, 20 * 1024 * 1024 + 1, "collapsed"],
    [10_000, 1, "collapsed"],
    [10_001, 1, "list-only"],
  ] as const)("%d files, %d bytes → %s", (files, size, scale) => {
    expect(scaleOf(files, size)).toBe(scale);
  });

  test("says what a large Review does", () => {
    expect(scaleNotice("full", 3)).toBeNull();
    expect(scaleNotice("collapsed", 2500)).toBe("2,500 files: each opens collapsed");
    expect(scaleNotice("list-only", 12000)).toContain("open one from the list");
  });
});

describe("marksCss", () => {
  const mark = (over: Partial<LineMark>): LineMark => ({
    item: itemKey(3),
    side: "new",
    start: 41,
    end: 41,
    severity: "high",
    ...over,
  });

  test("scopes a mark to its file and side, with the glyph on the first line only", () => {
    const css = marksCss([mark({ start: 41, end: 42 })]);

    expect(css).toContain(
      ':host([data-review-item="f3"]) [data-column-number="41"]:not([data-line-type="change-deletion"]) { box-shadow: inset 2px 0 0 var(--color-severity-high); }'
    );
    expect(css).toContain(
      '[data-column-number="41"]:not([data-line-type="change-deletion"])::before'
    );
    expect(css).not.toContain(
      '[data-column-number="42"]:not([data-line-type="change-deletion"])::before'
    );
    expect(css).toContain('[data-column-number="42"]');
  });

  test("old-side marks target deleted lines", () => {
    expect(marksCss([mark({ side: "old", start: 7, end: 7 })])).toContain(
      '[data-column-number="7"][data-line-type="change-deletion"]'
    );
  });

  test("the most severe mark wins a line, and long ranges are capped", () => {
    const css = marksCss([mark({ severity: "low" }), mark({ severity: "critical" })]);

    expect(css).toContain("var(--color-severity-critical)");
    expect(css).not.toContain("var(--color-severity-low)");
    const long = marksCss([mark({ start: 1, end: 10_000 })]);

    expect(long.match(/box-shadow/g)?.length).toBe(MAX_MARKED_LINES);
  });

  test("no marks, no stylesheet", () => {
    expect(marksCss([])).toBe("");
  });
});

describe("viewed", () => {
  test("a mark holds while the file's diff is unchanged", () => {
    const book = setViewed(emptyBook, "s", "a.ts", "abc");

    expect(isViewed(book, "s", "a.ts", "abc")).toBe(true);
    expect(isViewed(book, "s", "a.ts", "def")).toBe(false);
    expect(isViewed(setViewed(book, "s", "a.ts", null), "s", "a.ts", "abc")).toBe(false);
  });

  test("forgets the oldest subjects", () => {
    let book = emptyBook;

    for (let i = 0; i <= KEPT_SUBJECTS; i++) book = setViewed(book, `s${i}`, "f", "x");

    expect(book.order).toHaveLength(KEPT_SUBJECTS);
    expect(book.subjects.s0).toBeUndefined();
    expect(isViewed(book, `s${KEPT_SUBJECTS}`, "f", "x")).toBe(true);
  });

  test("a pull request's pending click wins over GitHub; dismissed reads as changed", () => {
    expect(pullFileViewed("viewed", undefined)).toBe("viewed");
    expect(pullFileViewed("dismissed", undefined)).toBe("changed");
    expect(pullFileViewed("unviewed", undefined)).toBe("unviewed");
    expect(pullFileViewed("viewed", false)).toBe("unviewed");
    expect(pullFileViewed("dismissed", true)).toBe("viewed");
  });

  test("a session's mark for another fingerprint reads as changed", () => {
    const book = setViewed(emptyBook, "s", "a.ts", "abc");

    expect(localViewed(book, "s", "a.ts", "abc")).toBe("viewed");
    expect(localViewed(book, "s", "a.ts", "def")).toBe("changed");
    expect(localViewed(book, "s", "b.ts", "abc")).toBe("unviewed");
  });

  test("progress", () => {
    expect(progressOf(3, 7)).toMatchObject({ label: "3 of 7 viewed" });
    expect(progressOf(0, 0).fraction).toBe(0);
  });
});

describe("layoutRows", () => {
  const files = indexPatch(bytes, []);

  const reviewFile = (section: string, i: number): ReviewFile => ({
    key: `${section}:${files[i]?.path}`,
    index: i,
    section,
    file: at(files, i),
    fingerprint: "x",
    generated: false,
    test: false,
  });

  const turn = (id: string, ...indices: ReadonlyArray<number>): ReviewSection => ({
    id,
    divider: { turn: Number(id), harness: "claude", quote: "Go" },
    files: indices.map((i) => reviewFile(id, i)),
  });

  const input = (over: Partial<LayoutInput>): LayoutInput => ({
    sections: [turn("1", 0, 2), turn("2", 1)],
    scale: "full",
    viewed: () => false,
    toggled: new Map(),
    openedSections: new Set(),
    openFile: null,
    ...over,
  });

  test("the first file of each Turn carries its divider; binary files start collapsed", () => {
    const rows = layoutRows(input({ sections: [turn("1", 0, 3)] }));

    expect(rows.map((r) => [r.file.key, r.collapsed, r.divider?.label ?? null])).toEqual([
      ["1:src/a.ts", false, "Turn 1"],
      ["1:img.png", true, null],
    ]);
    expect(rows[0]?.divider?.caption).toBe("2 files");
  });

  test("the newest Turn is open; older Turns fold, a run of them to one line", () => {
    const sections = [turn("4", 0), turn("3", 1), turn("2", 2), turn("1", 4)];
    const rows = layoutRows(input({ sections }));

    expect(rows.map((r) => [r.file.key, r.divider?.label, r.divider?.folded])).toEqual([
      ["4:src/a.ts", "Turn 4", false],
      ["3:new.ts", "Turns 1–3", true],
    ]);
    expect(rows[1]?.divider).toMatchObject({
      sectionIds: ["3", "2", "1"],
      caption: "3 files",
      quote: "Go",
      reviewed: false,
    });

    const opened = layoutRows(input({ sections, openedSections: new Set(["3", "2"]) }));

    expect(opened.map((r) => [r.file.key, r.divider?.label ?? null])).toEqual([
      ["4:src/a.ts", "Turn 4"],
      ["3:new.ts", "Turn 3"],
      ["2:gone.ts", "Turn 2"],
      ["1:run.sh", "Turn 1"],
    ]);
  });

  test("a reviewed newest Turn folds with a check; opening it shows its files", () => {
    const viewed = () => true;
    const rows = layoutRows(input({ sections: [turn("2", 0, 2)], viewed }));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.divider).toMatchObject({
      folded: true,
      reviewed: true,
      caption: "2 files · all viewed",
    });

    const opened = layoutRows(
      input({ sections: [turn("2", 0, 2)], viewed, openedSections: new Set(["2"]) })
    );

    expect(opened.map((r) => [r.file.key, r.collapsed])).toEqual([
      ["2:src/a.ts", true],
      ["2:gone.ts", true],
    ]);
  });

  test("generated files open collapsed and don't keep a Turn from reading reviewed", () => {
    const generated = (f: ReviewFile): ReviewFile => ({ ...f, generated: true });
    const section = turn("1", 0, 2);
    const sections = [{ ...section, files: [section.files[0]!, generated(section.files[1]!)] }];

    expect(layoutRows(input({ sections })).map((r) => r.collapsed)).toEqual([false, true]);

    const rows = layoutRows(input({ sections, viewed: (f) => f.index === 0 }));

    expect(rows[0]?.divider).toMatchObject({ folded: true, reviewed: true });
  });

  test("large Reviews open collapsed; the user's toggle wins", () => {
    const rows = layoutRows(
      input({
        sections: [turn("1", 0, 2, 1)],
        scale: "collapsed",
        toggled: new Map([["1:gone.ts", true]]),
      })
    );

    expect(rows.map((r) => r.collapsed)).toEqual([true, false, true]);
  });

  test("list-only shows only the open file", () => {
    expect(layoutRows(input({ scale: "list-only" }))).toEqual([]);
    expect(
      layoutRows(input({ scale: "list-only", openFile: "2:new.ts" })).map((r) => r.file.key)
    ).toEqual(["2:new.ts"]);
  });

  test("a pull request has no divider", () => {
    const rows = layoutRows(
      input({ sections: [{ id: "pr", divider: null, files: [reviewFile("pr", 0)] }] })
    );

    expect(rows[0]?.divider).toBeNull();
  });
});

describe("fileListRows", () => {
  const files = indexPatch(bytes, []).map((file, index): ReviewFile => ({
    key: file.path,
    index,
    section: "pr",
    file,
    fingerprint: "x",
    generated: false,
    test: false,
  }));

  const viewed = (f: ReviewFile) => f.index % 2 === 1;

  test("files to view first, then one row for the viewed ones", () => {
    const rows = fileListRows(files, viewed, new Set());

    expect(rows.map((r) => (r.kind === "file" ? r.file.key : `+${r.count}`))).toEqual([
      "src/a.ts",
      "gone.ts",
      "run.sh",
      "+2",
    ]);
  });

  test("opened, the viewed files follow it", () => {
    expect(fileListRows(files, viewed, new Set(["viewed"])).slice(-2)).toMatchObject([
      { kind: "file", viewed: true, file: { key: "new.ts" } },
      { kind: "file", viewed: true, file: { key: "img.png" } },
    ]);
    expect(fileListRows(files, () => false, new Set())).toHaveLength(5);
  });

  test("generated files fold last, viewed or not, and stay out of Viewed progress", () => {
    const marked = files.map((f) => ({
      ...f,
      generated: f.key === "gone.ts" || f.key === "new.ts",
    }));

    const rows = fileListRows(marked, viewed, new Set());

    expect(rows.map((r) => (r.kind === "file" ? r.file.key : `+${r.count} ${r.fold}`))).toEqual([
      "src/a.ts",
      "run.sh",
      "+1 viewed",
      "+2 generated",
    ]);
    expect(fileListRows(marked, viewed, new Set(["generated"])).slice(-2)).toMatchObject([
      { kind: "file", viewed: true, file: { key: "new.ts" } },
      { kind: "file", viewed: false, file: { key: "gone.ts" } },
    ]);
    expect(reviewProgress(marked, viewed).label).toBe("1 of 3 viewed");
  });
});

describe("selection tint and hunk labels", () => {
  test("tints the anchored lines in every file with the path, on their side", () => {
    const css = selectionCss({ items: ["f1", "f4"], side: "new", start: 7, end: 8 });

    expect(css).toContain(
      ':host([data-review-item="f1"]) [data-line="7"]:not([data-line-type="change-deletion"])'
    );
    expect(css).toContain(':host([data-review-item="f4"]) [data-column-number="8"]');
    expect(css).toContain("var(--color-diff-selection)");
    expect(selectionCss({ items: ["f1"], side: "old", start: 3, end: 3 })).toContain(
      '[data-line="3"][data-line-type="change-deletion"]'
    );
    expect(selectionCss(null)).toBe("");
    expect(selectionCss({ items: [], side: "new", start: 1, end: 2 })).toBe("");
  });

  test("a hunk's band reads its header line", () => {
    expect(hunkLabel("@@ -36,7 +36,8 @@ submitEligibility\n")).toBe(
      "@@ -36,7 +36,8 @@ submitEligibility"
    );
    expect(hunkLabel(undefined)).toBeNull();
    expect(hunkLabel("\n")).toBeNull();
    expect(
      hunkLabel(
        "@@ -36,7 +36,8 @@ export async function submitEligibility(form: EligibilityForm) {\n"
      )
    ).toBe("@@ -36,7 +36,8 @@ submitEligibility");
    expect(hunkLabel("@@ -1,4 +1,5 @@ class Limits extends Base {")).toBe("@@ -1,4 +1,5 @@ Limits");
    expect(hunkLabel("@@ -9,3 +9,3 @@ def fetch_rows(cursor):")).toBe("@@ -9,3 +9,3 @@ fetch_rows");
    expect(hunkLabel("@@ -9,3 +9,3 @@ export const incomeLimit = (household: number) =>")).toBe(
      "@@ -9,3 +9,3 @@ incomeLimit"
    );
    expect(hunkLabel("@@ -3,3 +3,3 @@")).toBe("@@ -3,3 +3,3 @@");
    expect(hunkLabel("@@ -3,3 +3,3 @@ ## Eligibility")).toBe("@@ -3,3 +3,3 @@ ## Eligibility");
  });
});

describe("paneState", () => {
  test("a diff with drawable files shows it", () => {
    expect(paneState({ files: 1, items: 1, complete: false, scale: "full" })).toEqual({
      kind: "diff",
    });
  });

  test("never an empty pane: reading, no changes, pick a file, or couldn't show", () => {
    expect(paneState({ files: 1, items: 0, complete: false, scale: "full" })).toMatchObject({
      title: "Reading the diff…",
    });
    expect(paneState({ files: 0, items: 0, complete: true, scale: "full" })).toMatchObject({
      title: "No changes",
    });
    expect(
      paneState({ files: 12_000, items: 0, complete: true, scale: "list-only" })
    ).toMatchObject({
      title: "Pick a file",
    });
    expect(paneState({ files: 1, items: 0, complete: true, scale: "full" })).toMatchObject({
      title: "Couldn’t show this diff",
      fact: "1 file changed, but none could be read",
    });
  });
});
