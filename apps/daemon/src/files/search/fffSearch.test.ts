import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FileFinder } from "@ff-labs/fff-bun";
import { removeTempDir, suiteTempDir, write } from "../../git/testing.ts";
import { fffGrep, MAX_CANDIDATES, narrowRegexGrep } from "./fffSearch.ts";
import type { GrepQuery } from "./types.ts";

let root: string;

let finder: FileFinder;

const createRoot = suiteTempDir("polaris-fffsearch-");

beforeAll(async () => {
  root = createRoot();

  // Filler files so the bigram index has something to tell apart.
  for (let i = 0; i < 300; i++) {
    write(
      root,
      `filler/f${i}.ts`,
      `export const filler${i} = "plain text ${i}"\nlet value = ${i}\n`
    );
  }

  write(
    root,
    "src/alpha.ts",
    [
      "export const needleAlpha = true",
      "export const needle = false",
      "function getValue() { return 1 }",
      "function setValue(v) { return v }",
      "parseInt('1'); parseFloat('2')",
      "colour and color",
      "fn main() {}",
      "  fn main() { indented }",
      "a.b*cde++ literal",
      "abcdefghi abcghi abcDEFghi",
      "ababab",
      "Größe größe GRÖSSE",
      "path\\to\\server",
    ].join("\n")
  );
  write(
    root,
    "src/beta.ts",
    [
      "NEEDLE upper",
      "Needle mixed",
      "the Kelvin sign: Keepalive and keepalive and KEEPALIVE",
      "long s: ſession and session and SESSION",
      "CheckPoint checkpoint CHECKPOINT",
      "xhandlerx yhandlery handlerz",
      "tab\there",
    ].join("\n")
  );
  // Only the non-ASCII case forms: (?i)workflow and (?i)submarine match these in Rust.
  write(root, "src/gamma.ts", "worKflow\nſubmarine\n");
  write(
    root,
    "docs/notes.md",
    "needle in the docs\nfn main is documented\nno literals here: 12345\n"
  );
  const created = FileFinder.create({ basePath: root, disableWatch: true });

  if (!created.ok) throw new Error(created.error);
  finder = created.value;
  await finder.waitForIndexReady(10_000);
});

afterAll(() => {
  finder?.destroy();
  removeTempDir(root);
});

const run = (query: GrepQuery, narrow: boolean) => {
  try {
    return { hits: fffGrep(finder, root, query, { narrow }) };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
};

const REGEXES = [
  "needle\\w*",
  "export const needle\\w+ = true",
  "(get|set)Value",
  "parseInt|parseFloat",
  "colou?r",
  "^fn main",
  "^\\s+fn main\\(\\)",
  "a\\.b\\*cde\\+\\+",
  "abc(def)?ghi",
  "abc(def)+ghi",
  "(ab){3}",
  "[Nn]eedle",
  "needle$",
  "(?i)needle",
  "(?i)keepalive",
  "(?i)session",
  "(?i)checkpoint",
  "(?i)workflow",
  "(?i)submarine",
  "Größe",
  "(?i)größe",
  "xhandlerx|yhandlery|handlerz",
  "\\\\server",
  "\\d{5}",
  ".*",
  "[a-z]+",
  "tab\\there",
  "needle(",
  "needle\\q",
  "(?x) n e e d l e",
];

describe("fff grep narrowing", () => {
  for (const pattern of REGEXES) {
    for (const caseSensitive of [true, false]) {
      test(`same results for /${pattern}/ (${caseSensitive ? "case-sensitive" : "insensitive"})`, () => {
        const query = { pattern, regex: true, caseSensitive, limit: 200 };
        expect(run(query, true)).toEqual(run(query, false));
      });
    }
  }

  for (const pattern of ["needle", "Größe", "keepalive", "a.b*c", "fn main()"]) {
    test(`same results for case-insensitive plain "${pattern}"`, () => {
      const query = { pattern, regex: false, caseSensitive: false, limit: 200 };
      expect(run(query, true)).toEqual(run(query, false));
    });
  }

  test("the limit applies the same way", () => {
    const query = { pattern: "filler\\d+", regex: true, caseSensitive: true, limit: 7 };
    expect(run(query, true)).toEqual(run(query, false));
  });

  test("a selective literal narrows; an unselective or missing one doesn't", () => {
    expect("glob" in narrowRegexGrep(finder, "export const needle\\w+ = true")).toBe(true);
    expect("glob" in narrowRegexGrep(finder, "(?i)needle")).toBe(true);
    expect("glob" in narrowRegexGrep(finder, "nothingMatchesThis\\d")).toBe(true);
    // In every filler file: more candidates than the cap.
    expect(MAX_CANDIDATES).toBeLessThan(300);
    expect(narrowRegexGrep(finder, "filler\\d+")).toEqual({ full: true });
    expect(narrowRegexGrep(finder, "[a-z]+")).toEqual({ full: true });
    // Tokens fff could read as constraints.
    expect(narrowRegexGrep(finder, "needle /src/")).toEqual({ full: true });
  });

  test("an invalid regex still fails when no file has the literal", () => {
    const query = { pattern: "nothingMatchesThis(", regex: true, caseSensitive: true, limit: 10 };
    const narrowed = run(query, true);
    expect(narrowed).toEqual(run(query, false));
    expect("error" in narrowed).toBe(true);
  });
});
