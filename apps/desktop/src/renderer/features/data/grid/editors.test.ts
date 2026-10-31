import { expect, test } from "bun:test";
import { Predicate } from "effect";
import { type ColumnFacts, draftOf, editorFor, parseDraft, sameTyped } from "./editors.ts";
import { DataValueTags } from "./value.ts";

const { BigInt: Big, Bytes, Json, Numeric, Timestamp, Truncated } = DataValueTags.cases;

const column = (
  type: string,
  extra: { nullable?: boolean; pk?: boolean; engine?: "postgres" | "mysql" } = {}
): ColumnFacts => {
  const facts = { name: "c", type, nullable: extra.nullable ?? true, pk: extra.pk ?? false };

  return extra.engine === undefined ? facts : { ...facts, engine: extra.engine };
};

const editable = (
  type: string,
  value: Parameters<typeof editorFor>[1],
  engine?: "postgres" | "mysql"
) => {
  const how = editorFor(column(type, engine === undefined ? {} : { engine }), value);

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
  expect(editable("timestamptz", null)).toMatchObject({ kind: "time", zone: "required" });
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
  expect(
    parseDraft(editable("timestamp without time zone", null), "2026-08-02 09:30", null)
  ).toMatchObject({
    value: Timestamp.make({ iso: "2026-08-02 09:30" }),
  });
  expect(errorOf(parseDraft(editable("date", null), "2026-08-02 09:30", null))).toBe(
    "Write a date as 2026-08-02"
  );
  expect(errorOf(parseDraft(zoned, "2026-13-45 09:30:00Z", null))).toBe(
    "Write a time as 2026-08-02 09:30:00+00:00"
  );
});

test("a column without a time zone refuses an offset and offers the local time instead", () => {
  for (const [type, engine] of [
    ["timestamp without time zone", "postgres"],
    ["datetime(6)", "mysql"],
  ] as const)
    expect(parseDraft(editable(type, null, engine), "2026-08-02 09:30:00+05:30", null)).toEqual({
      error: "This column has no time zone; write a local time",
      suggestion: "2026-08-02 09:30:00",
    });
  // MySQL's TIMESTAMP is absolute: its offset is required, as on timestamptz.
  expect(
    errorOf(parseDraft(editable("timestamp", null, "mysql"), "2026-08-02 09:30:00", null))
  ).toBe("Add an offset, like +00:00 or Z");
});

test("integer columns take whole numbers; numeric(p,s) refuses digits it would round", () => {
  for (const typed of ["2.7", ".5", "1e3"])
    expect(errorOf(parseDraft(editable("integer", 1), typed, 1))).toBe("A whole number, like 42");
  expect(errorOf(parseDraft(editable("int(10) unsigned", 1, "mysql"), "-3", 1))).toBe(
    "This column takes no negative numbers"
  );
  const money = editable("numeric(10,2)", Numeric.make({ value: "1.00" }));

  expect(errorOf(parseDraft(money, "1.005", null))).toBe("At most 2 digits after the point");
  expect(errorOf(parseDraft(money, "123456789", null))).toBe("At most 8 digits before the point");
  expect(parseDraft(money, "1.500", null)).toEqual({ value: Numeric.make({ value: "1.500" }) });
  // Floats are free.
  expect(errorOf(parseDraft(editable("double precision", 1), "1e3", 1))).toBeNull();
});

test("a value the column stores alike is a typed no-op: numbers, MySQL booleans, times, CRLF", () => {
  expect(sameTyped(editable("int4", 42), 42, Numeric.make({ value: "42.0" }))).toBe(true);
  expect(sameTyped(editable("int4", 42), 42, Numeric.make({ value: "43" }))).toBe(false);
  expect(sameTyped(editable("tinyint(1)", 1), 1, true)).toBe(true);
  expect(sameTyped(editable("tinyint(1)", 1), 1, false)).toBe(false);
  const zoned = editable("timestamptz", null);

  expect(
    sameTyped(
      zoned,
      Timestamp.make({ iso: "2026-10-30T06:30:00.123456+00:00" }),
      Timestamp.make({ iso: "2026-10-30 12:00:00.123456+05:30" })
    )
  ).toBe(true);
  expect(
    sameTyped(
      editable("timestamp without time zone", null),
      "2026-10-30 06:30:00",
      Timestamp.make({ iso: "2026-10-30 06:30" })
    )
  ).toBe(true);
  expect(sameTyped(editable("text", "a\r\nb"), "a\r\nb", "a\nb")).toBe(true);
});

test("text that was CRLF keeps its line ending when edited", () => {
  const crlf = editable("text", "one\r\ntwo");

  expect(parseDraft(crlf, "one\ntwo\nthree", "one\r\ntwo")).toEqual({
    value: "one\r\ntwo\r\nthree",
  });
});
