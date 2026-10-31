import { expect, test } from "bun:test";
import { Predicate } from "effect";
import { draftOf, editorFor, parseDraft } from "./editors.ts";
import { DataValueTags } from "./value.ts";

const { BigInt: Big, Bytes, Json, Numeric, Timestamp, Truncated } = DataValueTags.cases;

const column = (type: string, extra: { nullable?: boolean; pk?: boolean } = {}) => ({
  name: "c",
  type,
  nullable: extra.nullable ?? true,
  pk: extra.pk ?? false,
});

const editable = (type: string, value: Parameters<typeof editorFor>[1]) => {
  const how = editorFor(column(type), value);

  if (Predicate.isString(how)) throw new Error(how);

  return how;
};

test("binary, cut-short and key cells say why they can't be edited", () => {
  expect(editorFor(column("bytea"), Bytes.make({ length: 12 }))).toBe(
    "Binary values can't be edited here"
  );
  expect(editorFor(column("jsonb"), Truncated.make({ preview: "{", bytes: 2_000_000 }))).toContain(
    "cut short"
  );
  expect(editorFor(column("int8", { pk: true }), 1)).toContain("Key columns can't be changed");
});

test("each type gets its own editor, NULL cells by their column type", () => {
  expect(editable("text", "a").kind).toBe("text");
  expect(editable("int8", null).kind).toBe("number");
  expect(editable("tinyint(1)", 1).kind).toBe("bool");
  expect(editable("json", '{"a":1}').kind).toBe("json");
  expect(editable("timestamptz", null)).toMatchObject({ kind: "time", zoned: true });
  expect(editable("date", "2026-08-02")).toMatchObject({ kind: "time", dateOnly: true });
  expect(editorFor(column("text", { nullable: false }), "a")).toMatchObject({ nullable: false });
});

/** The message a draft is refused with, or null when it parses. */
const errorOf = (parsed: ReturnType<typeof parseDraft>) =>
  "error" in parsed ? parsed.error : null;

test("a numeric stays the text typed, so no digit is rounded", () => {
  const big = "12345678901234567890.123456789";

  expect(parseDraft(editable("numeric", Numeric.make({ value: "1" })), big, null)).toEqual({
    value: Numeric.make({ value: big }),
  });
  expect(
    parseDraft(
      editable("int8", Big.make({ value: "1" })),
      "9007199254740993",
      Big.make({ value: "1" })
    )
  ).toEqual({ value: Big.make({ value: "9007199254740993" }) });
  expect(parseDraft(editable("int4", 1), "12abc", 1)).toEqual({ error: "Not a number" });
});

test("JSON is checked before it stages, and kept as typed", () => {
  const json = editable("jsonb", Json.make({ text: "{}" }));

  expect(parseDraft(json, '{ "a": 1 }', null)).toEqual({
    value: Json.make({ text: '{ "a": 1 }' }),
  });
  expect(errorOf(parseDraft(json, '{ "a": ', null))).toStartWith("Not valid JSON · ");
});

test("a timestamp with a zone needs its offset; a date takes only a date", () => {
  const zoned = editable("timestamptz", Timestamp.make({ iso: "2026-08-02T09:30:00.000Z" }));

  expect(draftOf(Timestamp.make({ iso: "2026-08-02T09:30:00.000Z" }))).toBe("2026-08-02 09:30:00Z");
  expect(parseDraft(zoned, "2026-08-02 09:30:00", null)).toEqual({
    error: "Add an offset, like +00:00 or Z",
  });
  expect(parseDraft(zoned, "2026-08-02 09:30:00+02:00", null)).toEqual({
    value: Timestamp.make({ iso: "2026-08-02 09:30:00+02:00" }),
  });
  expect(parseDraft(editable("timestamp", null), "2026-08-02 09:30", null)).toMatchObject({
    value: Timestamp.make({ iso: "2026-08-02 09:30" }),
  });
  expect(errorOf(parseDraft(editable("date", null), "2026-08-02 09:30", null))).toBe(
    "Write a date as 2026-08-02"
  );
  expect(errorOf(parseDraft(zoned, "2026-13-45 09:30:00Z", null))).toBe(
    "Write a time as 2026-08-02 09:30:00+00:00"
  );
});
