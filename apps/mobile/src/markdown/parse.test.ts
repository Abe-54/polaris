import { describe, expect, test } from "bun:test";
import { lineOf } from "./line.ts";
import type { Span } from "./model.ts";
import { parseAfter, parseMarkdown } from "./parse.ts";

const blocks = (text: string) => parseAfter(null, text).blocks;

const span = (text: string, ...marks: ReadonlyArray<Span["marks"][number]>): Span => ({
  text,
  marks,
  href: null,
});

const link = (text: string, href: string): Span => ({ text, marks: [], href });

const spansOf = (text: string) => {
  const [first] = blocks(text);

  if (first === undefined || (first.kind !== "paragraph" && first.kind !== "heading"))
    throw new Error(`no text block in ${JSON.stringify(text)}`);

  return first.spans;
};

describe("blocks", () => {
  test("headings keep their level", () => {
    expect(blocks("# Plan\n\n### Risks")).toEqual([
      { kind: "heading", level: 1, spans: [span("Plan")] },
      { kind: "heading", level: 3, spans: [span("Risks")] },
    ]);
  });

  test("a fenced code block keeps its language and text verbatim", () => {
    expect(blocks("```ts\nconst a = **b** & 1;\n```")).toEqual([
      { kind: "code", lang: "ts", text: "const a = **b** & 1;" },
    ]);
  });

  test("lists number from their start, nest with a second bullet, and carry task boxes", () => {
    expect(blocks("3. one\n4. two\n   - inner\n- [x] done\n- [ ] open")).toEqual([
      {
        kind: "list",
        items: [
          { marker: "3.", checked: null, blocks: [{ kind: "paragraph", spans: [span("one")] }] },
          {
            marker: "4.",
            checked: null,
            blocks: [
              { kind: "paragraph", spans: [span("two")] },
              {
                kind: "list",
                items: [
                  {
                    marker: "◦",
                    checked: null,
                    blocks: [{ kind: "paragraph", spans: [span("inner")] }],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        kind: "list",
        items: [
          { marker: "•", checked: true, blocks: [{ kind: "paragraph", spans: [span("done")] }] },
          { marker: "•", checked: false, blocks: [{ kind: "paragraph", spans: [span("open")] }] },
        ],
      },
    ]);
  });

  test("a block quote holds blocks, and a rule is its own block", () => {
    expect(blocks("> quoted *text*\n\n---\n\nafter")).toEqual([
      {
        kind: "quote",
        blocks: [{ kind: "paragraph", spans: [span("quoted "), span("text", "em")] }],
      },
      { kind: "rule" },
      { kind: "paragraph", spans: [span("after")] },
    ]);
  });

  test("a table keeps alignment and sizes each column from its longest cell", () => {
    expect(blocks("| file | lines |\n|:--|--:|\n| serve.ts | **12** |\n| a | 3 |")).toEqual([
      {
        kind: "table",
        align: ["left", "right"],
        header: [[span("file")], [span("lines")]],
        rows: [
          [[span("serve.ts")], [span("12", "strong")]],
          [[span("a")], [span("3")]],
        ],
        columnChars: [8, 5],
      },
    ]);
  });
});

describe("inline", () => {
  test("emphasis, strikethrough and inline code become marked spans", () => {
    expect(spansOf("a **b** *c* ~~d~~ `e` **f *g***")).toEqual([
      span("a "),
      span("b", "strong"),
      span(" "),
      span("c", "em"),
      span(" "),
      span("d", "del"),
      span(" "),
      span("e", "code"),
      span(" "),
      span("f ", "strong"),
      span("g", "strong", "em"),
    ]);
  });

  test("web and mail links open; relative paths and app schemes stay text", () => {
    expect(
      spansOf(
        "[docs](https://polaris.dev) <ops@polaris.dev> [file](src/a.ts) [x](javascript:alert(1)) https://x.dev"
      )
    ).toEqual([
      link("docs", "https://polaris.dev"),
      span(" "),
      link("ops@polaris.dev", "mailto:ops@polaris.dev"),
      span(" file x "),
      link("https://x.dev", "https://x.dev"),
    ]);
  });

  test("character references decode in prose but not in code", () => {
    expect(spansOf("a &amp; b &#x2192; &lt;c&gt; `&amp;`")).toEqual([
      span("a & b → <c> "),
      span("&amp;", "code"),
    ]);
  });

  test("a soft line break is a space and a hard one a new line", () => {
    expect(spansOf("one\ntwo  \nthree")).toEqual([span("one two\nthree")]);
  });

  test("a tilde between numbers is not strikethrough, settled or still streaming", () => {
    expect(blocks("from 20~25 to 30~35\n\nthen 1~2 or 3~4")).toEqual([
      { kind: "paragraph", spans: [span("from 20~25 to 30~35")] },
      { kind: "paragraph", spans: [span("then 1~2 or 3~4")] },
    ]);
  });
});

describe("while streaming", () => {
  test.each([
    ["This is **bol", [span("This is "), span("bol", "strong")]],
    ["Use *care", [span("Use "), span("care", "em")]],
    ["Run `bun te", [span("Run "), span("bun te", "code")]],
    ["See [the docs](https://pola", [span("See the docs")]],
  ])("%j renders as it will end", (text, expected) => {
    expect(spansOf(text)).toEqual(expected);
  });

  test("an unterminated fence is a code block, and emphasis inside it is left alone", () => {
    expect(blocks("Here:\n\n```py\nx = **y")).toEqual([
      { kind: "paragraph", spans: [span("Here:")] },
      { kind: "code", lang: "py", text: "x = **y" },
    ]);
  });

  const DOCUMENT = [
    "# Plan\n\nI'll change **three** files:\n\n",
    "1. `serve.ts`, the [router](https://x.dev/r)\n2. *tests*\n\n",
    "> Note: 20~25 ms is fine\n> - quoted item\n\n- loose one\n\n- loose two\n  continued\n\n",
    "```ts\nconst a = 1;\nconst b = **2**;\n```\n\n",
    "| a | b |\n|---|--:|\n| 1 | 2 |\n\n---\n\nDone, see [ref].\n\n[ref]: https://x.dev\n",
  ].join("");

  test.each([1, 3])(
    "growing a message %i characters at a time matches a fresh parse at every step and the end",
    (stride) => {
      let parsed = parseAfter(null, "");

      for (let end = 1; end <= DOCUMENT.length; end += stride) {
        const text = DOCUMENT.slice(0, end);

        parsed = parseAfter(parsed, text);
        expect({ text, blocks: parsed.blocks }).toEqual({ text, blocks: blocks(text) });
      }

      expect(parseAfter(parsed, DOCUMENT).blocks).toEqual(blocks(DOCUMENT));
    }
  );

  test("settled blocks are kept as they were, so their views don't redraw", () => {
    const before = parseAfter(null, "# Plan\n\nFirst point.\n\nSecond");
    const after = parseAfter(before, "# Plan\n\nFirst point.\n\nSecond point, longer");

    expect(after.blocks[0]).toBe(before.blocks[0]);
    expect(after.blocks[1]).toBe(before.blocks[1]);
    expect(after.blocks[2]).toEqual({
      kind: "paragraph",
      spans: [span("Second point, longer")],
    });
  });

  test("a text that is not an extension parses from the start", () => {
    const before = parseAfter(null, "**old** text\n\nmore");

    expect(parseAfter(before, "new text").blocks).toEqual([
      { kind: "paragraph", spans: [span("new text")] },
    ]);
  });

  test("a finished message is parsed once, however often it is drawn", () => {
    const text = "Finished **message** for the cache.";

    expect(parseMarkdown(text)).toBe(parseMarkdown(text));
  });
});

describe("one line", () => {
  test("structure becomes markers and line breaks, styles stay", () => {
    expect(
      lineOf(blocks("## Status\n\n- [x] **tests** pass\n- lint\n\n```\nbun test\n```"))
    ).toEqual([
      span("Status", "strong"),
      span("\n"),
      span("✓ "),
      span("tests", "strong"),
      span(" pass"),
      span("\n"),
      span("• "),
      span("lint"),
      span("\n"),
      span("bun test", "code"),
    ]);
  });
});
