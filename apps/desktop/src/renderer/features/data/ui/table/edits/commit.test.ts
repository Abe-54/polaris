import { DataWriteResult } from "@polaris/protocol";
import { afterEach, expect, test } from "bun:test";
import type { CommitEditsInput, DataApi } from "../../../data/api.ts";
import { fixtureDataApi } from "../../../preview/fixtureApi.ts";
import { FIXTURE_SESSIONS, FIXTURE_SOURCES } from "../../../preview/fixtures.ts";
import {
  type CommitTarget,
  needsConfirm,
  requestCommit,
  runCommit,
  writesBlocked,
} from "./commit.ts";
import { noStaged, stage } from "./staged.ts";
import { editsOf, editsStore, stageEdit } from "./store.ts";

const at = { hostKey: "local", sessionId: FIXTURE_SESSIONS.overdue.id };

const [local, branch, production] = FIXTURE_SOURCES;

if (local === undefined || branch === undefined || production === undefined)
  throw new Error("fixture sources changed");

afterEach(() => editsStore.setState({ tabs: {}, closing: null }));

const target = (source = local): CommitTarget => ({
  at,
  tabId: "t",
  source,
  table: { schema: "public", name: "invoices" },
  primaryKey: ["id"],
});

const stageRows = (...ids: ReadonlyArray<number>) => {
  for (const id of ids)
    stageEdit(at, "t", { key: [id], column: "status", before: "open", value: "paid" });
};

/** A fake Host that records each commit and answers as told. */
const recording = (answer: "ok" | "fail" = "ok") => {
  const sent: Array<CommitEditsInput> = [];

  const api: DataApi = {
    ...fixtureDataApi(),
    commitEdits: async (_at, input) => {
      sent.push(input);

      return answer === "ok"
        ? { ok: true, value: new DataWriteResult({ queryId: "q", affected: 1, elapsedMs: 1 }) }
        : {
            ok: false,
            error: { code: "E-DATA-SQL", message: "duplicate key", fix: "Choose another value." },
          };
    },
  };

  return { api, sent };
};

test("only a remote commit of more than one row confirms", () => {
  const twoCellsOneRow = stage(stage(noStaged, { key: [1], column: "a", before: 0, value: 1 }), {
    key: [1],
    column: "b",
    before: 0,
    value: 1,
  });

  const twoRows = stage(twoCellsOneRow, { key: [2], column: "a", before: 0, value: 1 });

  expect(needsConfirm(branch, twoRows)).toBe(true);
  expect(needsConfirm(branch, twoCellsOneRow)).toBe(false);
  expect(needsConfirm(local, twoRows)).toBe(false);
});

test("a remote source takes the user's edits only when approved with writes allowed", () => {
  expect(writesBlocked(local)).toBeNull();
  expect(writesBlocked(branch)).toBeNull();
  expect(writesBlocked(production)).toBe("Writes need this remote data source approved first");
  expect(writesBlocked({ locality: "remote", access: "approved", writes: "off" })).toBe(
    "Writes are off for this remote data source"
  );
});

test("a commit sends every staged cell keyed by primary key, then shows them as written", async () => {
  const { api, sent } = recording();

  stageRows(7, 9);
  stageEdit(at, "t", { key: [7], column: "currency", before: null, value: "EUR" });
  await runCommit(api, target());

  expect(sent).toEqual([
    {
      source: "app",
      table: { schema: "public", name: "invoices" },
      primaryKey: ["id"],
      edits: [
        { key: [7], column: "status", value: "paid" },
        { key: [7], column: "currency", value: "EUR" },
        { key: [9], column: "status", value: "paid" },
      ],
    },
  ]);
  expect(editsOf(at, "t").staged.cells.size).toBe(0);
  expect(editsOf(at, "t").written).toHaveLength(3);
  expect(editsOf(at, "t").commit).toEqual({ status: "committed", count: { changes: 3, rows: 2 } });
});

test("a failed commit keeps every edit staged with its code and fix", async () => {
  const { api } = recording("fail");

  stageRows(7);
  await runCommit(api, target());

  expect(editsOf(at, "t").staged.cells.size).toBe(1);
  expect(editsOf(at, "t").commit).toMatchObject({
    status: "failed",
    error: { code: "E-DATA-SQL", fix: "Choose another value." },
  });
});

test("⌘S on a remote source commits one row at once but asks before two", async () => {
  const { api, sent } = recording();

  stageRows(7);
  requestCommit(api, target(branch));
  await Promise.resolve();
  expect(sent).toHaveLength(1);

  stageRows(8, 9);
  requestCommit(api, target(branch));
  expect(editsOf(at, "t").commit.status).toBe("confirming");
  expect(sent).toHaveLength(1);
});
