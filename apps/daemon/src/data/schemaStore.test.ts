import { Schema } from "effect";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SessionId, TurnId, TableDetail } from "@polaris/protocol";
import { SchemaStore, type SnapshotRecord } from "./schemaStore.ts";
import { table, catalog } from "./schemaSnapshots.testing.ts";

const sessionId = SessionId.make("s");

const turn = TurnId.make("t");

const record = (overrides: Partial<SnapshotRecord> = {}): SnapshotRecord => ({
  sessionId,
  turn,
  index: 0,
  checkout: "/repo",
  source: { id: "source", name: "app" },
  target: "target",
  baseline: "turn-start",
  before: catalog(),
  after: catalog(),
  used: true,
  failed: false,
  ...overrides,
});

const setup = () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE data_query_log (seq INTEGER PRIMARY KEY,id TEXT,checkout TEXT,value TEXT)");

  return { db, store: new SchemaStore(db) };
};

test("persisted per-table counts include own agent writes and user grid commits, excluding dry runs and other sessions", () => {
  const { db, store } = setup();

  try {
    store.put(
      record({
        after: {
          ...catalog(),
          tables: [
            new TableDetail({
              schema: "public",
              name: "invoices",
              columns: table().columns,
              indexes: [],
              constraints: [],
              rowEstimate: 900,
            }),
          ],
        },
      })
    );

    const put = (
      id: string,
      kind: string,
      rows: number,
      state = "completed",
      session = "s",
      tool = "execute",
      countedTurn = "t"
    ) =>
      db.query("INSERT INTO data_query_log(id,checkout,value) VALUES (?,?,?)").run(
        id,
        "/repo",
        JSON.stringify({
          source: { id: "source", name: "app" },
          state,
          tool,
          author: { kind, sessionId: session, turn: countedTurn },
          affected: [{ schema: "public", table: "invoices", rows }],
        })
      );

    put("a", "agent", 2);
    put("b", "user", 3, "completed", "s", "data.edits.commit");
    put("c", "agent", 99, "dry-run");
    put("d", "agent", 77, "completed", "other");
    put("e", "user", 66);
    expect(store.diff(sessionId, turn).sources[0]?.tables[0]?.rows).toEqual({
      kind: "exact",
      value: 5,
      agent: 2,
      user: 3,
    });
    expect(store.diff(sessionId, TurnId.make("other")).sources).toEqual([]);
    store.put({
      ...store.records(sessionId, turn)[0]!,
      affected: store.affected(sessionId, turn, "source"),
    });
    db.query("DELETE FROM data_query_log").run();
    expect(store.diff(sessionId, turn).sources[0]?.tables[0]?.rows).toEqual({
      kind: "exact",
      value: 5,
      agent: 2,
      user: 3,
    });
    put("f", "agent", 4, "completed", "s", "execute", "next");
    store.put(record({ turn: TurnId.make("next"), index: 1, baseline: "previous-turn-end" }));
    expect(store.diff(sessionId).sources[0]?.tables[0]?.rows).toEqual({
      kind: "exact",
      value: 9,
      agent: 6,
      user: 3,
    });
    store.remove(sessionId);
    expect(
      db.query<{ n: number }, []>("SELECT count(*) n FROM data_schema_snapshots").get()?.n
    ).toBe(0);
  } finally {
    db.close();
  }
});

test("missing affected counts use estimates and changed targets cannot form a whole-session comparison", () => {
  const { db, store } = setup();

  try {
    store.put(
      record({
        after: {
          ...catalog(),
          tables: [
            { ...Schema.encodeSync(TableDetail)(table("bills")), identity: "fixture-relation" },
          ],
        },
      })
    );
    expect(store.diff(sessionId, turn).sources[0]?.tables[0]?.rows).toEqual({
      kind: "estimate",
      value: 0,
    });
    store.put(record({ turn: TurnId.make("next"), index: 1, target: "different" }));
    expect(store.diff(sessionId).sources[0]).toMatchObject({ status: "unavailable", tables: [] });
  } finally {
    db.close();
  }
});

test("200 unchanged Turns share one catalog, retain 50 Turns, and report pruned history", () => {
  const { db, store } = setup();

  try {
    for (let index = 0; index < 200; index++)
      store.put(
        record({
          turn: TurnId.make(`t${index}`),
          index,
          before: { ...catalog(), at: `2026-10-30T00:00:${index % 60}Z` },
        })
      );
    expect(db.query("SELECT count(*) n FROM data_schema_catalogs").get()).toEqual({ n: 1 });
    expect(db.query("SELECT count(*) n FROM data_schema_snapshots").get()).toEqual({ n: 50 });
    expect(store.diff(sessionId, TurnId.make("t0"))).toMatchObject({ pruned: true, sources: [] });
    expect(store.diff(sessionId, TurnId.make("t199")).sources).toHaveLength(1);
    store.remove(sessionId);
    expect(db.query("SELECT count(*) n FROM data_schema_catalogs").get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});

test("the Host byte cap evicts oldest references and collects unreferenced catalogs", () => {
  const db = new Database(":memory:");
  const store = new SchemaStore(db, 2500);
  db.exec("CREATE TABLE data_query_log (seq INTEGER PRIMARY KEY,value TEXT)");

  try {
    for (let index = 0; index < 10; index++)
      store.put(
        record({
          turn: TurnId.make(`t${index}`),
          index,
          before: { ...catalog(), tables: [table(`table${index}`)] },
        })
      );
    expect(store.bytes()).toBeLessThanOrEqual(2500);
    expect(store.diff(sessionId, TurnId.make("t0")).pruned).toBe(true);
    expect(store.records(sessionId, "t9")).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("one-Turn reads and immediate-previous lookup never hydrate unrelated Turns", () => {
  const { db, store } = setup();

  try {
    store.put(record());
    store.put(record({ turn: TurnId.make("next"), index: 1 }));
    db.query(
      "UPDATE data_schema_snapshots SET value=json_set(value,'$.before.hash','missing') WHERE turn=?"
    ).run(turn);
    expect(store.records(sessionId, "next")).toHaveLength(1);
    expect(store.previous(sessionId, "source", 2)?.turn).toBe(TurnId.make("next"));
    expect(store.previous(sessionId, "source", 3)).toBeUndefined();
  } finally {
    db.close();
  }
});

test("legacy and injected catalog text is scrubbed before content-addressed persistence", () => {
  const { db, store } = setup();

  try {
    const detail = table();
    store.put(
      record({
        before: {
          ...catalog(),
          tables: [
            {
              ...Schema.encodeSync(TableDetail)(detail),
              columns: [{ ...detail.columns[0]!, default: "sk_live_KEEP_OUT" }],
              constraints: [
                {
                  name: "secret_check",
                  kind: "CHECK",
                  definition: "token <> _utf8mb4\\'sk_live_KEEP_OUT\\'",
                },
              ],
            },
          ],
        },
      })
    );
    const values = db.query<{ value: string }, []>("SELECT value FROM data_schema_catalogs").all();
    expect(values.map((x) => x.value).join()).not.toContain("sk_live_KEEP_OUT");
    expect(store.records(sessionId, turn)[0]?.before?.tables[0]?.columns[0]?.default).toBe(
      "[redacted]"
    );
  } finally {
    db.close();
  }
});

test("an evicted payload can be re-referenced by an in-flight next Turn", () => {
  const { db, store } = setup();

  try {
    store.put(record());
    const held = store.records(sessionId, turn)[0]!;
    store.remove(sessionId);
    const other = SessionId.make("other-session");
    store.put({ ...held, sessionId: other, turn: TurnId.make("in-flight") });
    expect(store.records(other, "in-flight")[0]?.before?.tables[0]?.name).toBe("invoices");
  } finally {
    db.close();
  }
});

test("legacy inline catalogs migrate into bounded, scrubbed, readable references", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE data_query_log (seq INTEGER PRIMARY KEY,id TEXT,checkout TEXT,value TEXT)");
  db.exec(
    "CREATE TABLE data_schema_snapshots (session TEXT,turn TEXT,source TEXT,value TEXT,PRIMARY KEY(session,turn,source))"
  );

  try {
    for (let index = 0; index < 200; index++) {
      const value = record({ turn: TurnId.make(`legacy${index}`), index });
      db.query("INSERT INTO data_schema_snapshots VALUES (?,?,?,?)").run(
        sessionId,
        value.turn,
        value.source.id,
        JSON.stringify(value)
      );
    }

    const store = new SchemaStore(db);
    expect(store.records(sessionId)).toHaveLength(50);
    expect(store.records(sessionId, "legacy199")[0]?.before?.tables[0]?.name).toBe("invoices");
    expect(db.query("SELECT count(*) n FROM data_schema_catalogs").get()).toEqual({ n: 1 });
    expect(store.diff(sessionId, TurnId.make("legacy0")).pruned).toBe(true);
  } finally {
    db.close();
  }
});
