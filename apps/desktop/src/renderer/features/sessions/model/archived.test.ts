import { describe, expect, test } from "bun:test";
import { SessionId, WorkspaceId } from "@polaris/protocol";
import { hostModel } from "../../../routes/fixtures.testing.ts";
import type { SessionEntry } from "../../../store/hostModel.ts";
import type { SessionData } from "../../../store/plain.ts";
import { archivedOf, archivedOpen } from "./archived.ts";

const base = [
  ...hostModel([{ id: "w", sessions: [{ id: "x", state: "idle" }] }]).sessions.values(),
][0]!;

const workspaceId = base.session.workspaceId;

const entry = (id: string, fields: Partial<SessionData> = {}): SessionEntry => ({
  ...base,
  session: { ...base.session, id: SessionId.make(id), title: id, state: "archived", ...fields },
});

const view = (name: string, state: string, lead: string, workers: ReadonlyArray<string> = []) => ({
  constellation: {
    name,
    state,
    leadSessionId: lead,
    attempts: [lead, ...workers].map((sessionId) => ({ sessionId })),
  },
});

const ids = (rows: ReturnType<typeof archivedOf>) => rows.map((r) => `${r.entry.session.id}`);

describe("archivedOf", () => {
  test("only this Workspace's archived sessions, most recently archived first", () => {
    const rows = archivedOf(
      [
        entry("older", { updatedAt: "2026-11-01T00:00:00.000Z" }),
        entry("live", { state: "idle" }),
        entry("elsewhere", { workspaceId: WorkspaceId.make("other") }),
        entry("newer", { updatedAt: "2026-11-02T00:00:00.000Z" }),
      ],
      workspaceId,
      []
    );

    expect(ids(rows)).toEqual(["newer", "older"]);
  });

  test("an archived worker stays out, as it does from every session list", () => {
    const rows = archivedOf([entry("lead"), entry("w1")], workspaceId, [
      view("Feeds", "completed", "lead", ["w1"]),
    ]);

    expect(ids(rows)).toEqual(["lead"]);
  });

  test("a lead whose Constellation hasn't ended is marked leaderless, an ended one isn't", () => {
    const rows = archivedOf([entry("a"), entry("b")], workspaceId, [
      view("Feeds", "running", "a"),
      view("Old", "completed", "b"),
    ]);

    expect(rows.map((r) => r.leaderless)).toEqual([{ name: "Feeds", state: "running" }, null]);
  });
});

describe("archivedOpen", () => {
  const plain = archivedOf([entry("a")], workspaceId, []);
  const leaderless = archivedOf([entry("a")], workspaceId, [view("Feeds", "paused", "a")]);

  test.each([
    ["plain, never toggled", plain, undefined, false],
    ["plain, unfolded", plain, false, true],
    ["leaderless, never toggled", leaderless, undefined, true],
    ["leaderless, folded by the user", leaderless, true, false],
  ] as const)("%s", (_, rows, folded, open) => {
    expect(archivedOpen(rows, folded)).toBe(open);
  });
});
