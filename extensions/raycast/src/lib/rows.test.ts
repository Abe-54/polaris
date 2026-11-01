import { Schema } from "effect";
import { ApprovalRequest } from "@polaris/protocol";
import { expect, test } from "bun:test";
import { approval, entry, hostView, workspace } from "./fixtures.testing.ts";
import {
  offersAlwaysAllow,
  approvalRows,
  sessionKey,
  sessionSections,
  workspaceRows,
} from "./rows.ts";

const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}T00:00:00.000Z`;

const mac = hostView("mac", [
  entry("asking", "working", day(1), { approvals: [approval("asking", "cargo-build", day(1))] }),
  entry("blocked", "needs-you", day(2)),
  entry("booting", "starting", day(3)),
  entry("busy", "working", day(4)),
  entry("resting", "dormant", day(5)),
  entry("done", "idle", day(6)),
  entry("put-away", "archived", day(7)),
]);

const pi = hostView("pi", [entry("pi-idle", "idle", day(8))]);

const titles = (query: Parameters<typeof sessionSections>[1]) =>
  sessionSections([mac, pi], query).map((section) => [
    section.title,
    section.rows.map((row) => String(row.entry.session.id)),
  ]);

const browsing = { host: null, pinned: new Set<string>(), searching: false };

test("sessions sort into Needs You, Working and Idle, newest first, without archived ones", () => {
  expect(titles(browsing)).toEqual([
    ["Needs You", ["blocked", "asking"]],
    ["Working", ["busy", "booting"]],
    ["Idle", ["pi-idle", "done", "resting"]],
  ]);
});

test("archived sessions are listed while searching", () => {
  expect(titles({ ...browsing, searching: true }).at(-1)).toEqual(["Archived", ["put-away"]]);
});

test("a pinned session leads its section; a Host filter keeps that Host's sessions", () => {
  const pinned = new Set([sessionKey("mac", "resting")]);

  expect(titles({ host: "mac", pinned, searching: false }).at(-1)).toEqual([
    "Idle",
    ["resting", "done"],
  ]);
});

test("a session's Workspace is named from its Host, or from its directory when hidden", () => {
  const rows = sessionSections(
    [
      hostView("mac", [
        entry("here", "idle", day(1)),
        entry("gone", "idle", day(2), { workspaceId: "w9" }),
      ]),
    ],
    browsing
  ).flatMap((section) => section.rows);

  expect(rows.map((row) => row.workspaceName)).toEqual(["elsewhere", "polaris"]);
});

test("approvals across Hosts list oldest first", () => {
  const other = hostView("pi", [
    entry("pi-asks", "needs-you", day(9), {
      approvals: [approval("pi-asks", "rm-rf", "2026-09-30T00:00:00.000Z")],
    }),
  ]);

  const late = hostView("mac", [
    entry("mac-asks", "needs-you", day(9), {
      approvals: [approval("mac-asks", "npm-test", day(3))],
    }),
  ]);

  expect(approvalRows([late, other], null).map((row) => String(row.approval.id))).toEqual([
    "rm-rf",
    "npm-test",
  ]);
  expect(approvalRows([late, other], "mac").map((row) => row.session.hostName)).toEqual([
    "Host mac",
  ]);
});

test("workspaces list by name with their agent sessions counted", () => {
  const view = hostView(
    "mac",
    [
      entry("a", "idle", day(1), { workspaceId: "w2" }),
      entry("b", "archived", day(1), { workspaceId: "w2" }),
    ],
    [workspace("w2", "zeta"), workspace("w1", "alpha")]
  );

  expect(workspaceRows([view], null).map((r) => [r.workspace.name, r.sessionCount])).toEqual([
    ["alpha", 0],
    ["zeta", 1],
  ]);
});

test("P9-10: Raycast offers no Always Approve for attach", () => {
  const ordinary = approval("s1", "r1", day(1));
  expect(offersAlwaysAllow(ordinary)).toBe(true);
  expect(
    offersAlwaysAllow(
      Schema.decodeUnknownSync(ApprovalRequest)({
        ...Schema.encodeSync(ApprovalRequest)(ordinary),
        profileAttach: { pid: 42, command: "node app", runtime: "node", seconds: 5 },
      })
    )
  ).toBe(false);
});
