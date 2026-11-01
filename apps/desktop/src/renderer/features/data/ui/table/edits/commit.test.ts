import { DataEditConflict, DataWriteResult } from "@polaris/protocol";
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
import { cellId, noStaged, rowId, sortStaged, stage } from "./staged.ts";
import { dropTab, editsOf, editsStore, overwriteEdit, stageEdit } from "./store.ts";

const at = { hostKey: "local", sessionId: FIXTURE_SESSIONS.overdue.id };

const [local, branch, production] = FIXTURE_SOURCES;

if (local === undefined || branch === undefined || production === undefined)
  throw new Error("fixture sources changed");

afterEach(() => editsStore.setState({ tabs: {}, closing: null }));

const target = (source = local, shown: (row: string) => boolean = () => true): CommitTarget => ({
  at,
  tabId: "t",
  source,
  table: { schema: "public", name: "invoices" },
  primaryKey: ["id"],
  shown,
});

const stageRows = (...ids: ReadonlyArray<number>) => {
  for (const id of ids)
    stageEdit(at, "t", { key: [id], column: "status", before: "open", value: "paid" });
};

type Answer = "ok" | "fail" | { readonly conflicts: ReadonlyArray<DataEditConflict> };

/** A fake Host that records each commit and answers as told. */
const recording = (answer: Answer = "ok", written?: DataWriteResult["written"]) => {
  const sent: Array<CommitEditsInput> = [];

  const api: DataApi = {
    ...fixtureDataApi(),
    commitEdits: async (_at, input) => {
      sent.push(input);

      if (answer === "ok")
        return {
          ok: true,
          value:
            written === undefined
              ? new DataWriteResult({ queryId: "q", affected: 1, elapsedMs: 1 })
              : new DataWriteResult({ queryId: "q", affected: 1, elapsedMs: 1, written }),
        };

      return answer === "fail"
        ? {
            ok: false,
            error: { code: "E-DATA-SQL", message: "duplicate key", fix: "Choose another value." },
          }
        : {
            ok: false,
            error: {
              code: "E-DATA-CONFLICT",
              message: "Some staged cells changed",
              fix: "Overwrite or drop each conflict.",
              conflicts: answer.conflicts,
            },
          };
    },
  };

  return { api, sent };
};

const { Changed, Missing } = DataEditConflict.cases;

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

test("a local source set to read only takes no edits either (writes off)", () => {
  expect(writesBlocked({ locality: "local", access: "read", writes: "off" })).toBe(
    "Writes are off for this data source"
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
        { key: [7], column: "status", before: "open", value: "paid" },
        { key: [7], column: "currency", before: null, value: "EUR" },
        { key: [9], column: "status", before: "open", value: "paid" },
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

test("a conflict writes nothing, marks the cells it names, and holds ⌘S until each is resolved", async () => {
  stageRows(7, 9);

  const conflicted = recording({
    conflicts: [
      Changed.make({ key: [7], column: "status", value: "void" }),
      Missing.make({ key: [9] }),
    ],
  });

  await runCommit(conflicted.api, target());

  const { staged, commit } = editsOf(at, "t");
  const sorted = sortStaged(staged, () => true);

  expect(commit.status).toBe("idle");
  expect(staged.cells.get(cellId([7], "status"))?.conflict).toEqual({
    kind: "changed",
    value: "void",
  });
  expect([...sorted.gone.keys()]).toEqual([rowId([9])]);
  expect(sorted.send.has(cellId([9], "status"))).toBe(false);

  const next = recording();

  requestCommit(next.api, target());
  await Promise.resolve();
  expect(next.sent).toEqual([]);

  // Overwrite: the next commit checks against the newer value, and the gone row isn't sent.
  overwriteEdit(at, "t", [cellId([7], "status")]);
  requestCommit(next.api, target());
  await Promise.resolve();
  expect(next.sent[0]?.edits).toEqual([
    { key: [7], column: "status", before: "void", value: "paid" },
  ]);
});

test("edits on rows not shown are neither counted nor sent", async () => {
  const { api, sent } = recording();

  stageRows(7, 9);
  await runCommit(
    api,
    target(local, (row) => row !== rowId([9]))
  );

  expect(sent[0]?.edits.map((e) => e.key)).toEqual([[7]]);
  expect(editsOf(at, "t").staged.cells.has(cellId([9], "status"))).toBe(true);
});

test("written cells take the database's own value, so the next edit checks against it", async () => {
  const { api } = recording("ok", [{ key: [7], column: "status", value: "PAID" }]);

  stageRows(7);
  await runCommit(api, target());

  expect(editsOf(at, "t").written).toEqual([
    { key: [7], column: "status", before: "open", value: "PAID" },
  ]);
});

test("a commit's answer never brings back a tab closed meanwhile", async () => {
  let land = () => {};

  const gate = new Promise<void>((resolve) => (land = resolve));

  const api: DataApi = {
    ...fixtureDataApi(),
    commitEdits: async () => {
      await gate;

      return { ok: true, value: new DataWriteResult({ queryId: "q", affected: 1, elapsedMs: 1 }) };
    },
  };

  stageRows(7);
  const running = runCommit(api, target());

  dropTab(at, "t");
  land();
  await running;
  expect(Object.keys(editsStore.getState().tabs)).toEqual([]);
});
