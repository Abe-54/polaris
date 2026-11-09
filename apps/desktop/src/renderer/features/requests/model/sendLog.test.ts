import { expect, test } from "bun:test";
import { fixtureSends } from "../preview/sendLogFixtures.ts";
import { sendGroups } from "./sendLog.ts";

/** 15:30 local, so the fixture's 95- and 170-minute-old Sends fall earlier today. */
const NOW = new Date(2026, 10, 9, 15, 30).getTime();

const titles = (id: string) => (id === "s-overdue-totals" ? "Fix overdue totals" : null);

const listed = (filter: string, now = NOW) =>
  sendGroups(fixtureSends(now), filter, new Date(now), titles).map((g) => [
    g.title,
    g.rows.map((r) => `${r.status} ${r.path} ${r.duration} ${r.by}`),
  ]);

test("Sends group by the last hour and earlier today, newest first, with no response as —", () => {
  expect(listed("")).toEqual([
    [
      "LAST HOUR",
      [
        "200 /invoices/overdue?recalculate=true 840 ms you",
        "— /invoices/overdue — Fix overdue totals",
        "200 /invoices/overdue?limit=50&customer=cus_8f2a&include=lines 46 ms Fix overdue totals",
        "422 /invoices/inv_2291 112 ms you",
      ],
    ],
    [
      "EARLIER TODAY",
      [
        "— /healthz 3 ms you",
        "500 /invoices/overdue?recalculate=true 1.3 s Fix overdue totals",
        "— /customers/cus_8f2a 30 s you",
      ],
    ],
  ]);
});

test("Sends from before today get their own group", () => {
  const groups = listed("", new Date(2026, 10, 9, 1, 0).getTime());

  expect(groups.map(([title]) => title)).toEqual(["LAST HOUR", "BEFORE TODAY"]);
});

test("every filter word must match the method, path, status, outcome or who sent it", () => {
  expect(listed("fix 500")).toEqual([
    ["EARLIER TODAY", ["500 /invoices/overdue?recalculate=true 1.3 s Fix overdue totals"]],
  ]);
  expect(listed("refused")).toEqual([["EARLIER TODAY", ["— /healthz 3 ms you"]]]);
  expect(listed("PATCH")).toEqual([["LAST HOUR", ["422 /invoices/inv_2291 112 ms you"]]]);
  expect(listed("nothing-like-this")).toEqual([]);
});
