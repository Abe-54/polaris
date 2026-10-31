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
    store.put(record({ after: { ...catalog(), tables: [table("bills")] } }));
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
