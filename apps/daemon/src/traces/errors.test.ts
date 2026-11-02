import { expect, test } from "bun:test";
import { openTraceDatabase, sortableTime } from "./database.ts";
import { fingerprint, spanErrors, spanErrorsPlan, type SpanErrorsFilter } from "./errors.ts";

test.each([
  ["DataError: branch 7mmvvc5m9g0t does not exist", "DataError: branch <id> does not exist"],
  [`syntax error at or near "'User'"`, "syntax error at or near <str>"],
  [
    "DataError: This table does not exist in this SQLite file.\n    at ie (/$bunfs/root/chunk-mmmn02bf.js:2:674)",
    "DataError: This table does not exist in this SQLite file.",
  ],
  [
    "FileError: ENOENT: no such file or directory, stat '/Users/me/code/next.js/.git'\n    at fil",
    "FileError: ENOENT: no such file or directory, stat <str>",
  ],
  ["FileError: is a directory: /Users/me/code/mail/.git", "FileError: is a directory: <path>"],
  [
    "session 0b6f1c2e-6a4d-4c1e-9f3a-2d5e8b7c9a10 not found after 3 attempts",
    "session <uuid> not found after <n> attempts",
  ],
  ["trace 4bf92f3577b34da6a3ce929d0e0e4736 expired", "trace <id> expired"],
  ["fetch https://api.example.com/v1/items?id=42 failed: 503", "fetch <url> failed: <n>"],
  ["  Timeout   after  1.5 s\nstack", "Timeout after <n> s"],
])("fingerprint(%p) is %p", (message, expected) => {
  expect(fingerprint(message)).toBe(expected);
});

test("messages that differ only in ids, paths and numbers share a fingerprint; words don't", () => {
  expect(fingerprint("branch 7mmvvc5m9g0t does not exist")).toBe(
    fingerprint("branch q2w8e4r1t6y9 does not exist")
  );
  expect(fingerprint("is a directory: /a/b/.git")).toBe(fingerprint("is a directory: /c/d/e/.git"));
  expect(fingerprint("table users does not exist")).not.toBe(
    fingerprint("table invoices does not exist")
  );
});

test("a 100 KB single-line message fingerprints quickly to a bounded key", () => {
  const huge = `Error: ${"a1b2c3d4-".repeat(5_000)}${"x9".repeat(30_000)} "unterminated ${"'".repeat(20_000)}`;
  const started = performance.now();
  const key = fingerprint(huge);

  expect(performance.now() - started).toBeLessThan(50);
  expect(key.length).toBeLessThanOrEqual(200);
  expect(key).toStartWith("Error: <id>");
});

const filter: SpanErrorsFilter = { sinceMs: 1_000, limit: 20 };

const database = (rows: ReadonlyArray<{ age: number; message: string; status?: string }>) => {
  const db = openTraceDatabase(":memory:");

  const insert =
    db.query(`INSERT INTO spans (checkout,trace_id,id,parent,start,end,service,status,age,bytes,value,name,duration)
    VALUES ('checkout',?,?,NULL,?,?,'api',?,?,100,?,'data.query',1)`);

  for (const [index, row] of rows.entries()) {
    const start = sortableTime((BigInt(row.age) * 1_000_000n).toString());
    const value = JSON.stringify({ statusMessage: row.message, events: [] });
    insert.run(
      `trace-${index}`,
      `span-${index}`,
      start,
      start,
      row.status ?? "error",
      row.age,
      value
    );
  }

  return db;
};

test("the scan reads errored spans in the window only, and a capped scan says where it stopped", () => {
  const db = database([
    { age: 500, message: "branch a1b2c3d4e5 does not exist" },
    { age: 2_000, message: "branch f6g7h8i9j0 does not exist" },
    { age: 3_000, message: "branch k1l2m3n4o5 does not exist" },
    { age: 4_000, message: "timeout" },
    { age: 5_000, message: "branch p6q7r8s9t0 does not exist" },
    { age: 6_000, message: "ok", status: "ok" },
  ]);

  expect(spanErrors(db, "checkout", filter)).toMatchObject({
    spans: 4,
    truncated: false,
    coveredSince: null,
    fingerprints: [
      {
        fingerprint: "branch <id> does not exist",
        message: "branch p6q7r8s9t0 does not exist",
        count: 3,
        firstSeen: new Date(2_000).toISOString(),
        lastSeen: new Date(5_000).toISOString(),
        example: { trace: "trace-4", span: "span-4" },
      },
      { fingerprint: "timeout", count: 1 },
    ],
  });
  expect(spanErrors(db, "checkout", filter, 2)).toMatchObject({
    spans: 2,
    truncated: true,
    coveredSince: new Date(4_000).toISOString(),
  });
});

test("an empty status message falls back to the exception event's message", () => {
  const db = openTraceDatabase(":memory:");

  const value = JSON.stringify({
    statusMessage: "",
    events: [
      { name: "log", attributes: {} },
      { name: "exception", attributes: { "exception.message": "boom 42" } },
    ],
  });

  db.query(`INSERT INTO spans (checkout,trace_id,id,parent,start,end,service,status,age,bytes,value,name,duration)
    VALUES ('checkout','t','s',NULL,'1','1','api','error',2000,1,?,'x',1)`).run(value);

  expect(spanErrors(db, "checkout", filter).fingerprints).toMatchObject([
    { fingerprint: "boom <n>", message: "boom 42" },
  ]);
});

test("every filter combination range-scans spans_age on checkout, status and age without a sort", () => {
  const db = database([]);

  for (const extra of [{}, { name: "data" }, { service: "api" }, { service: "api", name: "x" }]) {
    const plan = spanErrorsPlan(db, "checkout", { ...filter, ...extra }).join("\n");

    expect(plan).toMatch(
      /^SEARCH s USING INDEX spans_age \(checkout=\? AND status=\? AND age>\?\)/
    );
    expect(plan).not.toContain("TEMP B-TREE");
  }
});
