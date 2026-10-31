import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { DataSource, DataValueTags, SessionId } from "@polaris/protocol";
import { Deferred, Effect, Fiber, Redacted } from "effect";
import { ApprovalStore } from "./approvalStore.ts";
import { editStatements } from "./writeEdits.ts";
import { bindValues } from "./execution.ts";
import { writePlan } from "./writeSql.ts";
import { commitWindow } from "./writeCommit.ts";
import { targetLocks } from "./writeLocks.ts";
import { parseConnection } from "./connection.ts";
import { cappedPreview } from "./writeExecution.ts";

const source = (
  engine: "postgres" | "mysql" = "postgres",
  locality: "local" | "remote" = "local"
) =>
  new DataSource({
    id: "app",
    name: "app",
    engine,
    host: "localhost",
    port: 5432,
    database: "app",
    user: "u",
    locality,
    foundIn: { kind: "manual" },
    access: "read",
    writes: "ask",
    label: { text: "", colour: "none" },
  });

test("F5: revoking Local defaults creates no write grant for a later Remote target", () => {
  const db = new Database(":memory:");

  try {
    const approvals = new ApprovalStore(db);
    approvals.change(source(), undefined, true);
    expect(db.query("SELECT * FROM data_approval_rules").all()).toEqual([]);
    expect(approvals.read(source())).toEqual({ access: "read", writes: "ask" });
    expect(approvals.read(source("postgres", "remote"))).toEqual({
      access: "needs-approval",
      writes: "off",
    });
    approvals.change(source(), "ask");
    expect(approvals.read(source("postgres", "remote")).writes).toBe("off");
    approvals.change(source("postgres", "remote"), "ask");
    expect(approvals.read(source("postgres", "remote")).writes).toBe("ask");
  } finally {
    db.close();
  }
});

test("F7/F8: upserts and MySQL cross-database subqueries fail before a transaction", () => {
  for (const engine of ["postgres", "mysql"] as const) {
    const sql =
      engine === "postgres"
        ? "INSERT INTO items(id) VALUES(1) ON CONFLICT(id) DO UPDATE SET id=2"
        : "INSERT INTO items(id) VALUES(1) ON DUPLICATE KEY UPDATE id=2";

    expect(() =>
      writePlan(sql, source(engine), { engine, sqlMode: "", standardConformingStrings: true })
    ).toThrow("Upserts");
  }

  expect(() =>
    writePlan("UPDATE items SET v=(SELECT COUNT(*) FROM app.t, other.t)", source("mysql"), {
      engine: "mysql",
      sqlMode: "",
    })
  ).toThrow("joins");

  for (const sql of [
    "UPDATE other.items SET v=1",
    "UPDATE items SET v=(SELECT v FROM other.items)",
  ])
    expect(() => writePlan(sql, source("mysql"), { engine: "mysql", sqlMode: "" })).toThrow(
      "different database"
    );
  expect(
    writePlan("UPDATE public.items SET v=1", source(), {
      engine: "postgres",
      standardConformingStrings: true,
    }).target
  ).toEqual({ schema: "public", table: "items" });
});

test("F11/F12: typed keys ignore object field order and Bytes bind their complete payload", () => {
  const a = DataValueTags.cases.Bytes.make({ length: 2, base64: "AP8=" });
  const b = DataValueTags.cases.Bytes.make({ base64: "AP8=", length: 2 });
  expect(bindValues([a])).toEqual([Buffer.from([0, 255])]);
  expect(() => bindValues([DataValueTags.cases.Bytes.make({ length: 2 })])).toThrow(
    "no bindable bytes"
  );
  expect(() => bindValues([DataValueTags.cases.Bytes.make({ length: 3, base64: "AP8=" })])).toThrow(
    "incomplete"
  );
  expect(() =>
    editStatements(
      {
        sessionId: SessionId.make("s"),
        source: "app",
        table: { schema: "public", name: "t" },
        primaryKey: ["id"],
        edits: [
          { key: [a], column: "v", value: 1 },
          { key: [b], column: "v", value: 2 },
        ],
      },
      "postgres"
    )
  ).toThrow("same cell");
});

test("F9: preview persistence redacts credential columns, values and independently caps INSERT after rows", () => {
  const connection = parseConnection({
    name: "app",
    url: Redacted.make("postgres://u:credential@localhost/app"),
    foundIn: { kind: "manual" },
  })!.connection;

  const result = cappedPreview(
    {
      columns: [
        { name: "api_token", type: 25 },
        { name: "v", type: 25 },
      ],
      rows: [],
      raw: undefined,
    },
    [
      ["row-secret", "credential"],
      ["another", "safe"],
    ],
    { source: source(), connection, sql: "", dryRun: true }
  );

  expect(result).toEqual({
    columns: ["api_token", "v"],
    before: [],
    after: [
      ["[redacted]", "[redacted]"],
      ["[redacted]", "safe"],
    ],
  });
});

test("F3: a lost or overdue COMMIT is unknown; confirmed COMMIT stays successful", async () => {
  const success = commitWindow(async () => {});
  success.start();
  expect(await success.wait(Promise.resolve(42))).toBe(42);
  const lost = commitWindow(async () => {});
  lost.start();
  await Promise.resolve(
    expect(lost.wait(Promise.reject(new Error("connection lost")))).rejects.toMatchObject({
      code: "E-DATA-OUTCOME-UNKNOWN",
      fix: "Check the rows in the database before retrying this write.",
    })
  );
  let closed = false;

  const overdue = commitWindow(async () => {
    closed = true;
  }, 5);

  overdue.start();
  await Promise.resolve(
    expect(overdue.wait(new Promise(() => {}))).rejects.toMatchObject({
      code: "E-DATA-OUTCOME-UNKNOWN",
    })
  );
  expect(closed).toBe(true);
});

test("F13: a held target lock allows another target through and queues its own second write", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const lock = targetLocks();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();

        const first = yield* lock(
          "A",
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
        ).pipe(Effect.forkChild);

        yield* Deferred.await(entered);
        let sameTargetRan = false;

        const same = yield* lock(
          "A",
          Effect.sync(() => {
            sameTargetRan = true;
          })
        ).pipe(Effect.forkChild);

        const other = yield* lock("B", Effect.succeed("B completed")).pipe(
          Effect.timeout("1 second")
        );

        expect(other).toBe("B completed");
        expect(sameTargetRan).toBe(false);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(same);
        expect(sameTargetRan).toBe(true);
      })
    )
  ));
