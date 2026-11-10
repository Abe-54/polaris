import { beforeAll, describe, expect, test } from "bun:test";
import {
  type DiffsHighlighter,
  getSharedHighlighter,
  registerCustomTheme,
  renderFileWithHighlighter,
} from "@pierre/diffs";
import { moonlitTheme, THEMES } from "../diffs/theme.ts";
import { MAX_HIGHLIGHT_LINES } from "../editor/diff/data/highlightTokens.ts";
import {
  type DiffSyntax,
  fileSyntax,
  type HighlightLines,
  lineSyntax,
  runsOfRow,
} from "./diffSyntax.ts";
import { type DiffFile, parseUnifiedDiff } from "./model/diff.ts";

let highlighter: DiffsHighlighter;

beforeAll(async () => {
  registerCustomTheme(THEMES.dark, () => Promise.resolve(moonlitTheme("dark")));
  registerCustomTheme(THEMES.light, () => Promise.resolve(moonlitTheme("light")));
  highlighter = await getSharedHighlighter({
    themes: [THEMES.dark, THEMES.light],
    langs: ["typescript", "python"],
    preferredHighlighter: "shiki-js",
  });

  // The first highlight per language compiles its grammar (~0.5 s, several under load).
  const { highlight } = highlights();

  await highlight("warm.ts", "const a = `${1}`; // x");
  await highlight("warm.py", "def a():\n    return 1");
}, 30_000);

/** Pierre's highlight as the pool's workers run it, counting the texts it was asked for. */
const highlights = () => {
  const asked: Array<string> = [];

  const highlight: HighlightLines = (path, text) => {
    asked.push(text);

    return Promise.resolve(
      renderFileWithHighlighter({ name: path, contents: text }, highlighter, {
        theme: THEMES,
        tokenizeMaxLineLength: 1000,
        useTokenTransformer: false,
      }).code
    );
  };

  return { asked, highlight };
};

const only = (patch: string): DiffFile => {
  const [file] = parseUnifiedDiff(patch);

  if (file === undefined) throw new Error("no file in the patch");

  return file;
};

/** Each line as the reader sees it: `kind text` then its coloured words ("keyword:const"). */
const coloured = (syntax: DiffSyntax, file: DiffFile) =>
  file.hunks.flatMap((hunk) =>
    hunk.lines.map((line) => {
      const merged: Array<{ group: string | null; text: string }> = [];

      for (const run of lineSyntax(syntax, file.path, line) ?? []) {
        const last = merged.at(-1);

        if (last?.group === run.group) last.text += run.text;
        else merged.push({ ...run });
      }

      const words = merged.flatMap((r) =>
        r.group === null ? [] : [`${r.group}:${r.text.trim()}`]
      );

      return `${line.kind} ${line.text} | ${words.join(" ")}`;
    })
  );

const syntaxOf = async (file: DiffFile, highlight = highlights().highlight) => {
  const syntax = await fileSyntax(file, highlight);

  return new Map(syntax === null ? [] : [[file.path, syntax]]);
};

const MODIFIED = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 import { x } from "./x";
-let port = 22;
+const port = "22";
 export default port;
`;

describe("the Changes tab's syntax colours", () => {
  test("removed lines colour on the old side, added and context lines on the new", async () => {
    const file = only(MODIFIED);

    expect(coloured(await syntaxOf(file), file)).toEqual([
      'context import { x } from "./x"; | keyword:import punctuation:{ punctuation:} keyword:from punctuation:" string:./x punctuation:";',
      "remove let port = 22; | keyword:let punctuation:= string:22 punctuation:;",
      'add const port = "22"; | keyword:const punctuation:= " string:22 punctuation:";',
      "context export default port; | keyword:export default punctuation:;",
    ]);
  });

  test("a construct left open in one hunk doesn't colour the next", async () => {
    const file = only(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;
 /* the rest is long
@@ -40,2 +40,2 @@
-let b = 1;
+let b = 2;
`);

    const lines = coloured(await syntaxOf(file), file);

    expect(lines[2]).toBe("context /* the rest is long | comment:/* the rest is long");
    expect(lines.slice(3)).toEqual([
      "remove let b = 1; | keyword:let punctuation:= string:1 punctuation:;",
      "add let b = 2; | keyword:let punctuation:= string:2 punctuation:;",
    ]);
  });

  test("a hunk opening inside a comment or template colours what it can and keeps every column", async () => {
    const file = only(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -10,3 +10,3 @@
  * still the comment */
-  more \`template\` text\`;
+  more \`template\` text\`; const x = 1;
 }
`);

    const syntax = await syntaxOf(file);

    for (const line of file.hunks.flatMap((h) => h.lines)) {
      const runs = lineSyntax(syntax, file.path, line);

      if (runs !== undefined) expect(runs.map((r) => r.text).join("")).toBe(line.text);
    }
  });

  test("a highlighted row that doesn't spell its line stays plain", () => {
    const row = {
      type: "element",
      children: [
        {
          type: "element",
          properties: { style: "--diffs-token-dark:var(--color-syntax-keyword)" },
          children: [{ type: "text", value: "const" }],
        },
        { type: "text", value: " a\n" },
      ],
    };

    expect(runsOfRow(row, "const a")).toEqual([
      { text: "const", group: "keyword" },
      { text: " a", group: null },
    ]);
    expect(runsOfRow(row, "const ab")).toBeNull();
    expect(runsOfRow(undefined, "const a")).toBeNull();
  });

  test("a renamed file's old side colours in its old language", async () => {
    const file = only(`diff --git a/tool.py b/tool.ts
similarity index 50%
rename from tool.py
rename to tool.ts
--- a/tool.py
+++ b/tool.ts
@@ -1 +1 @@
-def run(): pass
+function run() {}
`);

    expect(coloured(await syntaxOf(file), file)).toEqual([
      "remove def run(): pass | keyword:def function:run punctuation:(): keyword:pass",
      "add function run() {} | keyword:function function:run punctuation:() {}",
    ]);
  });

  test("a deleted file colours its removed lines and asks for no new side", async () => {
    const { asked, highlight } = highlights();

    const file = only(`diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const a = 1;
-export { a };
`);

    expect(coloured(await syntaxOf(file, highlight), file)).toEqual([
      "remove const a = 1; | keyword:const punctuation:= string:1 punctuation:;",
      "remove export { a }; | keyword:export punctuation:{ punctuation:};",
    ]);
    expect(asked).toEqual(["const a = 1;\nexport { a };"]);
  });

  test("a file past the highlight limit, or in an unknown language, stays plain unasked", async () => {
    const { asked, highlight } = highlights();

    const body = Array.from({ length: MAX_HIGHLIGHT_LINES + 1 }, (_, i) => `+const v${i} = ${i};`);

    const long = only(
      `diff --git a/big.ts b/big.ts\nnew file mode 100644\n--- /dev/null\n+++ b/big.ts\n@@ -0,0 +1,${body.length} @@\n${body.join("\n")}\n`
    );

    const unknown = only(`diff --git a/notes.zzz b/notes.zzz
--- a/notes.zzz
+++ b/notes.zzz
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`);

    expect(await fileSyntax(long, highlight)).toBeNull();
    expect(await fileSyntax(unknown, highlight)).toBeNull();
    expect(asked).toEqual([]);
  });
});
