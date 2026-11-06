import { afterAll, describe, expect, test } from "bun:test";
import { gitText } from "../git/git.ts";
import { commitAll, makeRepo, removeTempDir, write } from "../git/testing.ts";
import { addedLines, overlapsAdded, parseAddedLines } from "./addedLines.ts";

const repos: Array<string> = [];

afterAll(() => repos.forEach(removeTempDir));

describe("parseAddedLines", () => {
  test.each<[string, ReadonlyArray<string>, ReadonlyArray<[string, Array<[number, number]>]>]>([
    [
      "keeps the new side's ranges and drops pure deletions",
      [
        "diff --git a.ts a.ts",
        "--- a.ts",
        "+++ a.ts",
        "@@ -1,0 +2,3 @@",
        "+one",
        "+two",
        "+three",
        "@@ -9 +11,0 @@",
        "-gone",
        "@@ -20 +22 @@",
        "-old",
        "+new",
      ],
      [
        [
          "a.ts",
          [
            [2, 4],
            [22, 22],
          ],
        ],
      ],
    ],
    [
      "an added line reading `++ x` is content, not a file header",
      ["--- a.md", "+++ a.md", "@@ -1,0 +1,2 @@", "+++ not a header", "+tail"],
      [["a.md", [[1, 2]]]],
    ],
    [
      "deleted files are absent; quoted paths are unquoted",
      [
        "--- gone.ts",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-a",
        "-b",
        '--- "caf\\303\\251 \\"x\\".ts"',
        '+++ "caf\\303\\251 \\"x\\".ts"',
        "@@ -0,0 +1 @@",
        "+a",
        "\\ No newline at end of file",
      ],
      [['café "x".ts', [[1, 1]]]],
    ],
  ])("%s", (_name, diff, expected) => {
    expect([...parseAddedLines(diff.join("\n"))]).toEqual([...expected]);
  });

  test("overlap, not start line, decides", () => {
    const added = parseAddedLines(["+++ a.ts", "@@ -5 +5 @@", "-x", "+y"].join("\n"));

    expect(overlapsAdded(added, "a.ts", 3, 5)).toBe(true);
    expect(overlapsAdded(added, "a.ts", 5, 9)).toBe(true);
    expect(overlapsAdded(added, "a.ts", 6, 9)).toBe(false);
    expect(overlapsAdded(added, "b.ts", 5, 5)).toBe(false);
  });
});

describe("addedLines", () => {
  test("reads a real diff between two commits, following a rename", async () => {
    const repo = await makeRepo({ "old.ts": "a\nb\nc\n", "keep.ts": "1\n2\n" });
    repos.push(repo);
    const base = await gitText(repo, ["rev-parse", "HEAD"]);
    removeTempDir(`${repo}/old.ts`);
    write(repo, "new.ts", "a\nb\nc\nd\n");
    write(repo, "keep.ts", "1\nchanged\n2\n");
    const head = await commitAll(repo, "edit");

    const added = await addedLines(repo, base, head);

    expect(Object.fromEntries(added)).toEqual({ "new.ts": [[4, 4]], "keep.ts": [[2, 2]] });
  });
});
