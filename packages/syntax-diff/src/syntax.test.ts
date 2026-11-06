import { describe, expect, test } from "bun:test";
import {
  alignLines,
  myers,
  splitLines,
  syntaxDiff,
  tokenizerFor,
  tokenLines,
  TooComplex,
} from "./index.ts";
import { typescriptTokenizer } from "./typescript.ts";

const lines = (source: string, path = "a.ts") =>
  tokenLines(source, typescriptTokenizer.tokenize(source, path));

const rows = (before: string, after: string, path = "a.ts") =>
  alignLines(lines(before, path), lines(after, path));

/** The marked text on one side, as a reader sees it. */
const marked = (before: string, after: string, path = "a.ts") => {
  const patch = syntaxDiff(before, after, path, typescriptTokenizer);
  const text = (side: "old" | "new") => splitLines(side === "old" ? before : after);

  return patch.emphasis.map((e) => `${e.side}:${text(e.side)[e.line - 1]?.slice(e.start, e.end)}`);
};

describe("myers", () => {
  test("finds the shortest edit script, by index", () => {
    const a = "abcabba".split("");
    const b = "cbabac".split("");
    const ops = myers(a.length, b.length, (i, j) => a[i] === b[j]);

    expect(ops.filter((op) => op.type !== "equal")).toHaveLength(5);

    for (const op of ops) if (op.type === "equal") expect(a[op.a]).toBe(b[op.b] ?? "");
  });

  test("gives up past the edit cap", () => {
    expect(() => myers(4, 4, () => false, 2)).toThrow(TooComplex);
  });
});

describe("lines", () => {
  test("a template literal across lines is words on the lines that hold them", () => {
    const source = "const csp = `default-src 'self';\n  img-src https://a.example;`;\n";
    const [first, second] = lines(source);

    expect(first?.tokens.map((t) => t.text)).toEqual([
      "const",
      "csp",
      "=",
      "`default-src",
      "'self'",
      ";",
    ]);
    expect(second?.tokens.map((t) => t.text)).toEqual([
      "img-src",
      "https://a.example",
      ";",
      "`",
      ";",
    ]);
  });

  test("spacing doesn't change a line's fingerprint; a comment does", () => {
    const [spaced, tight, commented] = lines("a = b + 1;\na=b+1;\na = b + 1; // why\n");

    expect(spaced?.fingerprint).toBe(tight?.fingerprint ?? "");
    expect(commented?.fingerprint).not.toBe(spaced?.fingerprint ?? "");
  });

  test("a final line break adds no line", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
  });
});

describe("syntax-aware rows", () => {
  test("an added property marks only the new tokens, and nothing is removed", () => {
    const before = "const host = { name: 'pi', port: 22 };\n";
    const after = "const host = { name: 'pi', user: 'lucas', port: 22 };\n";

    expect(rows(before, after).map((r) => r.kind)).toEqual(["inserted"]);
    expect(marked(before, after)).toEqual(["new:user: 'lucas',"]);
  });

  test.each([
    [
      "a rename marks the old and the new name, nothing else",
      "export function dial(host: Host) {}\n",
      "export function connect(host: Host) {}\n",
      "a.ts",
      ["old:dial", "new:connect"],
    ],
    [
      "an edit in a block comment marks the words that changed",
      "/**\n * Keep retrying until the host answers.\n */\nexport const x = 1;\n",
      "/**\n * Keep retrying quietly until the host answers.\n */\nexport const x = 1;\n",
      "a.ts",
      ["new:quietly"],
    ],
    [
      "a line comment is part of its line: editing it is a change of a few words",
      "retry(); // once\n",
      "retry(); // once more\n",
      "a.ts",
      ["new:more"],
    ],
    [
      "a URL added to a multi-line template literal marks just that URL",
      "const csp = `\n  default-src 'self';\n  img-src 'self';\n`;\n",
      "const csp = `\n  default-src 'self';\n  img-src 'self' https://cdn.example;\n`;\n",
      "a.ts",
      ["new:https://cdn.example"],
    ],
    [
      "JSX text edits mark words",
      "export const A = () => <p>Hello there</p>;\n",
      "export const A = () => <p>Hello over there</p>;\n",
      "a.tsx",
      ["new:over"],
    ],
  ])("%s", (_, before, after, path, marks) => {
    expect(marked(before, after, path)).toEqual(marks);
  });

  test("a reindented block is not a change; whole new and removed lines are", () => {
    const before = "if (a) {\nrun();\n}\nold();\n";
    const after = "if (a) {\n  run();\n}\nfresh();\nmore();\n";

    expect(rows(before, after).map((r) => r.kind)).toEqual([
      "equal",
      "equal",
      "equal",
      "modified",
      "added",
    ]);
  });
});

describe("the patch", () => {
  test("hunks keep three lines of context and git's line numbers", () => {
    const before = Array.from({ length: 12 }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n";
    const after = before.replace("const v6 = 6;", "const v6 = 60;");
    const { patch, inserted } = syntaxDiff(before, after, "n.ts", typescriptTokenizer);

    expect(patch.split("\n").slice(0, 3)).toEqual(["--- a/n.ts", "+++ b/n.ts", "@@ -4,7 +4,7 @@"]);
    expect(patch).toContain("-const v6 = 6;\n+const v6 = 60;");
    expect(inserted).toEqual([]);
  });

  test("an in-line insertion is a context line, listed by its new line number", () => {
    const { patch, inserted } = syntaxDiff("f(a);\n", "f(a, b);\n", "x.ts", typescriptTokenizer);

    expect(patch).toBe("--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n f(a, b);\n");
    expect(inserted).toEqual([1]);
  });

  test("a new file starts at line zero on the old side", () => {
    expect(syntaxDiff("", "a;\n", "x.ts", typescriptTokenizer).patch).toContain("@@ -0,0 +1,1 @@");
  });

  test("only spacing changed: no patch", () => {
    expect(syntaxDiff("a=1;\n", "a = 1;\n", "x.ts", typescriptTokenizer).patch).toBe("");
  });
});

describe("tokenizers", () => {
  test("TypeScript reads every JavaScript and TypeScript dialect and JSON; others have none", () => {
    for (const path of ["a.ts", "a.tsx", "a.mts", "a.js", "a.jsx", "a.cjs", "a.json"])
      expect(tokenizerFor(path)?.id).toBe("typescript");

    expect(tokenizerFor("a.py")).toBeNull();
    expect(tokenizerFor("README.md")).toBeNull();
  });
});
