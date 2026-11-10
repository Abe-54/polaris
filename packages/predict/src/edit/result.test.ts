import { expect, test } from "bun:test";
import { diffEdits } from "./diff.ts";
import { request } from "./fixtures.testing.ts";
import { applyEdits, guardEdits } from "./guards.ts";
import { buildEditPrompt } from "./prompt.ts";
import { spikeEditOptions } from "./options.ts";
import { editResult as resultWith } from "./result.ts";
import { editWindow } from "./window.ts";

// Parsing and revert mechanics, without the hill-climbed guards (hillclimb.test.ts covers those).
const editResult: typeof resultWith = (request, output, elapsed) =>
  resultWith(request, output, elapsed, spikeEditOptions);

const input = { ...request, buffer: "const value = 1;", cursor: 15 };

test("line then character alignment produces disjoint minimal UTF-16 hunks", () => {
  const before = "😀 old + old\r\nkeep\r\nremove\r\n";
  const after = "😀 new + new\r\nkeep\r\n";
  const edits = diffEdits(before, after);
  expect(edits).toEqual([
    { from: 3, to: 6, text: "new" },
    { from: 9, to: 12, text: "new" },
    { from: 20, to: 28, text: "" },
  ]);
  expect(applyEdits(before, edits)).toBe(after);
  expect(diffEdits("const x = '😀';", "const x = '😃';")).toEqual([
    { from: 11, to: 13, text: "😃" },
  ]);
});

test("Zeta cursor is in the resulting buffer, otherwise the last hunk supplies it", () => {
  const withCursor = editResult(
    input,
    "<|marker_1|>const value = <|user_cursor|>200;\n<|marker_2|>"
  );

  expect(withCursor.edits).toEqual([{ from: 14, to: 15, text: "200" }]);
  expect(withCursor.cursor).toBe(14);
  expect(editResult(input, "<|marker_1|>const value = 200;\n<|marker_2|>").cursor).toBe(17);
  expect(editResult(input, "<|marker_1|>const value = 1;\n<|marker_2|>").cursor).toBeNull();
});

test("focus centres whole-line windows independently of the cursor", () => {
  const buffer = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const focused = { ...request, buffer, cursor: 0, focus: buffer.indexOf("line 50") };
  const zeta = buildEditPrompt(focused, spikeEditOptions);
  expect(zeta.window.from).toBe(buffer.indexOf("line 37"));
  expect(zeta.window.to).toBe(buffer.indexOf("line 66"));
  const sweep = buildEditPrompt({ ...focused, format: "sweep-next-edit" }, spikeEditOptions);
  expect(sweep.window.from).toBe(buffer.indexOf("line 40"));
  expect(sweep.window.to).toBe(buffer.indexOf("line 61"));
  expect(() => editWindow({ ...focused, focus: buffer.length + 1 })).toThrow("outside the buffer");
});

test("CRLF regions and cursor offsets preserve the buffer's line endings", () => {
  const buffer = "a\r\nb\r\nc";

  const result = editResult(
    { ...request, buffer, cursor: 3 },
    "<|marker_1|>a\nbb<|user_cursor|>\nc\n<|marker_2|>"
  );

  expect(result.edits).toEqual([{ from: 4, to: 4, text: "b" }]);
  expect(result.cursor).toBe(5);
  expect(applyEdits(buffer, result.edits)).toBe("a\r\nbb\r\nc");
});

test("multiple Zeta regions map cursor through preceding region length changes", () => {
  const buffer = "a\nb\nc\nd\ne\nf";

  const result = editResult(
    { ...request, buffer, cursor: 0 },
    "<|marker_1|>aaa\nb\nc\n<|marker_2|>d\neee<|user_cursor|>\nf<|marker_3|>"
  );

  expect(applyEdits(buffer, result.edits)).toBe("aaa\nb\nc\nd\neee\nf");
  expect(result.cursor).toBe(13);
});

test("region boundaries do not create cancelling hunks for a moved line", () => {
  const buffer = "a\nb\nc\nd\ne\nf";

  const result = editResult(
    { ...request, buffer, cursor: 0 },
    "<|marker_1|>a\nb\nc\nd\n<|marker_2|>e\nf<|marker_3|>"
  );

  expect(result.edits).toEqual([]);
});

test("unknown regions are suppressed, malformed and truncated markers fail closed", () => {
  const result = editResult(input, "<|marker_3|>bad<|marker_4|>");
  expect(result.edits).toEqual([]);
  expect(result.suppressed).toEqual([
    { reason: "outside-window", from: 0, to: input.buffer.length },
  ]);

  for (const raw of [
    "plain code",
    "<|marker_1|>truncated",
    "<|marker_1|>x<|marker_2|>garbage",
    "<|marker_1|>a<|user_cursor|>b<|user_cursor|><|marker_2|>",
  ])
    expect(() => editResult(input, raw)).toThrow("Malformed");
});

test("outside-window guard rejects offsets outside the rewritable range", () => {
  const window = { ...editWindow(input), from: 5, to: 10 };
  expect(guardEdits(input, window, [{ from: 2, to: 3, text: "x" }])).toEqual({
    edits: [],
    suppressed: [{ reason: "outside-window", from: 2, to: 3 }],
  });
});

test("a user's accepted edit cannot be undone, but another file's history does not suppress it", () => {
  const output = "<|marker_1|>const value = 2;\n<|marker_2|>";
  const history = [{ path: input.path, line: 0, before: "const value = 2;", after: input.buffer }];
  const result = editResult({ ...input, history }, output);
  expect(result.edits).toEqual([]);
  expect(result.suppressed).toEqual([{ reason: "revert", from: 14, to: 15 }]);
  expect(
    editResult({ ...input, history: [{ ...history[0]!, path: "other.ts" }] }, output).edits
  ).toEqual([{ from: 14, to: 15, text: "2" }]);
});

test("unrelated whitespace churn drops a mixed rewrite atomically", () => {
  const buffer = "const x = 1;\nconst y = 2;";

  const result = editResult(
    { ...request, buffer, cursor: 10 },
    "<|marker_1|>const x = 3;\n  const y = 2;\n<|marker_2|>"
  );

  expect(result.edits).toEqual([]);
  expect(result.suppressed.map((hunk) => hunk.reason)).toEqual(["unstable", "unstable"]);
});

test("diff work is bounded for pathological rewrites", () => {
  expect(() => diffEdits("a".repeat(5000), "b".repeat(5000))).toThrow("too complex");
});

test("empty consecutive Zeta markers delete a region, repeated markers abstain", () => {
  const buffer = "a\nb\nc\nd";
  const result = editResult({ ...request, buffer, cursor: 0 }, "<|marker_1|><|marker_2|>");
  expect(result.edits).toEqual([{ from: 0, to: 6, text: "" }]);
  expect(applyEdits(buffer, result.edits)).toBe("d");
  expect(result.cursor).toBe(0);
  const repeated = editResult({ ...request, buffer, cursor: 0 }, "<|marker_1|><|marker_1|>");
  expect(repeated.edits).toEqual([]);
  expect(repeated.suppressed).toEqual([]);
  expect(repeated.cursor).toBeNull();
});

test("whitespace-only echoes still report each dropped hunk", () => {
  const buffer = "const x = 1;\nconst y = 2;";

  const result = editResult(
    { ...request, buffer, cursor: 10 },
    "<|marker_1|>const x = 1;\n  const y = 2;\n<|marker_2|>"
  );

  expect(result.edits).toEqual([]);
  expect(result.suppressed).toEqual([{ reason: "unstable", from: 13, to: 13 }]);
});
