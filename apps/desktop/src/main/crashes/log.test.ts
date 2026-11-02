import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { CRASH_LOG, CRASH_LOG_PREVIOUS, createCrashLog } from "./log.ts";

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A logs directory that doesn't exist yet, as on a first launch. */
const freshDir = () => {
  const root = mkdtempSync(join(tmpdir(), "polaris-crashes-"));

  roots.push(root);

  return join(root, "logs");
};

const decodeLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number])))
);

const lines = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => decodeLine(line));

test("each entry is one JSON line with when, which version and what failed", () => {
  const dir = freshDir();
  const log = createCrashLog({ dir, version: "1.2.3", now: () => new Date(Date.UTC(2026, 10, 2)) });

  log.write({
    process: "renderer",
    kind: "boundary",
    pane: "review",
    message: "boom",
    stack: "at x",
  });

  expect(lines(join(dir, CRASH_LOG))).toEqual([
    {
      at: "2026-11-02T00:00:00.000Z",
      version: "1.2.3",
      platform: process.platform,
      process: "renderer",
      kind: "boundary",
      pane: "review",
      message: "boom",
      stack: "at x",
    },
  ]);
});

test("past its size the log rolls over to crashes.1.log, keeping two files at most", () => {
  const dir = freshDir();
  const log = createCrashLog({ dir, version: "1", maxBytes: 400 });

  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
    log.write({ process: "main", kind: "unresponsive", message: `entry ${n} ${"x".repeat(60)}` });
  }

  const current = readFileSync(join(dir, CRASH_LOG), "utf8");
  const previous = readFileSync(join(dir, CRASH_LOG_PREVIOUS), "utf8");

  expect(current.length).toBeLessThanOrEqual(400);
  expect(previous.length).toBeLessThanOrEqual(400);
  expect(current).toContain("entry 8");
  expect(previous).not.toContain("entry 1 ");
});

test("a huge stack is cut, so one crash can't fill the log", () => {
  const dir = freshDir();
  const log = createCrashLog({ dir, version: "1" });

  log.write({
    process: "renderer",
    kind: "error",
    message: "m".repeat(50_000),
    stack: "s".repeat(100_000),
  });

  const [entry] = lines(join(dir, CRASH_LOG));

  expect(entry?.["message"]).toMatch(/^m{1999}…$/);
  expect(JSON.stringify(entry).length).toBeLessThan(20_000);
});

test("an unwritable directory loses the entry without throwing", () => {
  const dir = freshDir();
  const log = createCrashLog({ dir: join(dir, "\0bad"), version: "1" });

  expect(() => log.write({ process: "main", kind: "unresponsive", message: "x" })).not.toThrow();
  expect(existsSync(join(dir, CRASH_LOG))).toBe(false);
});
