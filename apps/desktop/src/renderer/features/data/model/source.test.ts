import { describe, expect, test } from "bun:test";
import { DataSource } from "@polaris/protocol";
import { Schema } from "effect";
import { FIXTURE_SOURCES } from "../preview/fixtures.ts";
import { accessText, barParts, formatEstimate, kickerText, statusText } from "./source.ts";

// SAFETY: the fixtures hold app, the ledger branch and analytics, in that order.
const [app, branch, analytics] = FIXTURE_SOURCES as [DataSource, DataSource, DataSource];

const fields = Schema.encodeSync(DataSource);

const relabel = (source: DataSource, text: string) =>
  new DataSource({ ...fields(source), label: { ...source.label, text } });

describe("the connection bar's words", () => {
  test("a branch reads as its engine's major.minor, its provider, the branch and the database", () => {
    expect(barParts(branch)).toEqual(["MySQL 8.0 · PlanetScale", "overdue-totals", "ledger"]);
    expect(barParts(app)).toEqual(["PostgreSQL 16.4", "localhost:5432", "ledger_overdue"]);
  });

  test("an empty label falls back to the branch's name, else where the source is", () => {
    expect([
      kickerText(relabel(branch, " ")),
      kickerText(relabel(app, "")),
      kickerText(app),
    ]).toEqual(["OVERDUE-TOTALS", "LOCAL", "LOCAL"]);
  });

  test.each([
    ["read", "ask", "Agents read · writes ask you"],
    ["read", "off", "Agents read · writes off"],
    ["approved", "ask", "Approved · writes ask you"],
    ["approved", "off", "Approved · agents read only"],
    ["needs-approval", "off", "Agents can't reach it until you approve it"],
    ["denied", "ask", "Denied · agents can't reach it"],
  ] as const)("access %s with writes %s reads %p", (access, writes, text) => {
    expect(accessText(new DataSource({ ...fields(analytics), access, writes }))).toBe(text);
  });
});

test("the card's status says why a source can't be reached", () => {
  expect([
    statusText(app),
    statusText(new DataSource({ ...fields(app), reachable: false, error: "connection refused" })),
  ]).toEqual(["connected", "can't reach it · connection refused"]);
});

describe("row estimates", () => {
  test.each([
    [null, ""],
    [0, "0"],
    [962, "962"],
    [1312, "1.3k"],
    [2000, "2k"],
    [12_400, "12k"],
    [4_120_000, "4.1M"],
    [2_500_000_000, "2.5B"],
  ] as const)("%p rows read %p", (n, text) => {
    expect(formatEstimate(n)).toBe(text);
  });
});
