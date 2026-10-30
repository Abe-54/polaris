import { expect, test } from "bun:test";
import { Redacted, Schema } from "effect";
import {
  DataError,
  DataHost,
  DataSource,
  DataValue,
  DataValueTags,
  RequestId,
  QueryResult,
  QueryData,
  QueryDataStream,
  QueryDataStreamItem,
  QueryLogEntry,
  PageDataQueryLog,
  SaveDataSource,
  SchemaTree,
  ApprovalDecision,
  DataRpcs,
  scrubCredentials,
  scrubDataValue,
} from "./index.ts";

const url = "postgres://app:hunter2@db.internal:5432/app";

const source = {
  id: "app",
  name: "app",
  engine: "postgres",
  locality: "remote",
  host: "db.internal",
  port: 5432,
  database: "app",
  user: "app",
  foundIn: { kind: "manual" },
  access: "needs-approval",
  writes: "ask",
  label: { text: "", colour: "none" },
  reachable: false,
};

const log = {
  id: "q1",
  checkout: "/work",
  source: { id: "app", name: "app" },
  sql: `select '${url}'`,
  params: [url],
  state: "waiting-approval",
  author: { kind: "outside", sessionId: "s1", turn: "t1", command: `psql ${url}` },
  at: "2026-10-30T00:00:00Z",
};

test("F1: credentials are scrubbed on decode and encode of source errors, SQL, params and commands", () => {
  const decode = Schema.decodeUnknownSync(QueryLogEntry);
  const entry = decode({ ...log, error: `password=hunter2 ${url}` });
  expect(JSON.stringify(entry)).not.toContain("hunter2");
  expect(entry.state).toBe("waiting-approval");

  const raw = new QueryLogEntry({
    id: entry.id,
    checkout: entry.checkout,
    source: entry.source,
    author: entry.author,
    state: entry.state,
    at: entry.at,
    sql: url,
  });

  expect(JSON.stringify(Schema.encodeSync(QueryLogEntry)(raw))).not.toContain("hunter2");

  const dataSource = Schema.decodeUnknownSync(DataSource)({ ...source, error: url });
  expect(dataSource.error).toBe("postgres://[redacted]@db.internal:5432/app");

  const error = new DataError({ code: "E-DATA-SQL", message: url, fix: "PGPASSWORD=hunter2 psql" });
  expect(JSON.stringify(Schema.encodeSync(DataError)(error))).not.toContain("hunter2");
});

test.each([
  ["PGPASSWORD='hunter 2' psql", "PGPASSWORD=[redacted] psql"],
  ['host=db password="hunter 2" dbname=app', "host=db password=[redacted] dbname=app"],
  ["mysql://app:hun%40ter@db/app", "mysql://[redacted]@db/app"],
  ["password=hunter2; next", "password=[redacted]; next"],
  [String.raw`password='hun\'ter2' host=db`, "password=[redacted] host=db"],
])("F1: scrubs credential syntax %s", (input, expected) => {
  expect(scrubCredentials(input)).toBe(expected);
});

test("F1: exact credentials in innocuous values and errors are masked longest first; short secrets are ignored", () => {
  const known = [Redacted.make("hunter2"), Redacted.make(url), Redacted.make("abc")];
  expect(scrubCredentials(`SQL failed: hunter2 ${url} abc alphabet`, known)).toBe(
    "SQL failed: [redacted] [redacted] abc alphabet"
  );
  expect(scrubDataValue("innocuous hunter2", known)).toBe("innocuous [redacted]");
  expect(
    scrubDataValue(DataValueTags.cases.Json.make({ text: '{"innocent":"hunter2"}' }), known)
  ).toEqual(
    DataValueTags.cases.Json.make({
      text: '{"innocent":"[redacted]"}',
    })
  );
});

test("F1: Data hosts reject userinfo and URLs while admitting hosts, IPv6 and socket paths", () => {
  expect(Schema.is(DataHost)("app:hunter2@db.internal")).toBe(false);
  expect(Schema.is(DataHost)(url)).toBe(false);

  for (const host of ["db.internal", "127.0.0.1", "[::1]", "/var/run/postgresql"])
    expect(Schema.is(DataHost)(host)).toBe(true);
});

test("F2: normalised values survive JSON round trips without losing integer precision", () => {
  const values = [
    null,
    true,
    "text",
    1.5,
    DataValueTags.cases.BigInt.make({ value: "12345678901234567890" }),
    DataValueTags.cases.Numeric.make({ value: "100.001000000000000001" }),
    DataValueTags.cases.Timestamp.make({ iso: "2026-10-30T10:00:00+02:00" }),
    DataValueTags.cases.Bytes.make({ length: 3, preview: "AQID" }),
    DataValueTags.cases.Json.make({ text: '{"a":1}' }),
  ];

  const result = Schema.decodeUnknownSync(QueryResult)({
    queryId: "q1",
    columns: [],
    rows: [values],
    rowCount: 1,
    returned: 1,
    total: 18402,
    truncated: true,
    elapsedMs: 3,
  });

  expect(result.returned).toBe(1);
  expect(result.total).toBe(18402);

  expect(
    Schema.decodeUnknownSync(QueryResult)(
      JSON.parse(JSON.stringify(Schema.encodeSync(QueryResult)(result)))
    )
  ).toEqual(result);
});

test.each([12345678901234567890n, new Date(), new Uint8Array([1, 2, 3]), Infinity, { nested: 1 }])(
  "F2: raw driver value %p is refused at the contract boundary",
  (value) => {
    expect(() => Schema.decodeUnknownSync(DataValue)(value)).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(QueryData.payloadSchema)({
        sessionId: "s",
        source: "app",
        sql: "select $1",
        params: [value],
      })
    ).toThrow();
  }
);

test("F4/F6: agent and Desktop limits differ and cells/chunks are bounded before framing", () => {
  const input = { sessionId: "s", source: "app", sql: "select 1", limit: 10000 };
  expect(() => Schema.decodeUnknownSync(QueryData.payloadSchema)(input)).toThrow();
  expect(Schema.decodeUnknownSync(QueryDataStream.payloadSchema)(input).limit).toBe(10000);
  expect(() =>
    Schema.decodeUnknownSync(QueryDataStream.payloadSchema)({ ...input, limit: 10001 })
  ).toThrow();
  expect(() => Schema.decodeUnknownSync(DataValue)("x".repeat(17 * 1024 * 1024))).toThrow();
  expect(() => Schema.decodeUnknownSync(DataValue)("😀".repeat(20000))).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(QueryDataStreamItem)(
      QueryDataStreamItem.cases.Rows.make({
        rows: Array.from({ length: 30 }, () => ["x".repeat(40000)]),
      })
    )
  ).toThrow();
  expect(
    Schema.decodeUnknownSync(DataValue)(
      DataValueTags.cases.Truncated.make({
        preview: "large text…",
        bytes: 17825792,
      })
    )
  ).toEqual(DataValueTags.cases.Truncated.make({ preview: "large text…", bytes: 17825792 }));
});

test("F5: only RespondToApproval's decision carries Data scope; the bypass RPC is gone", () => {
  expect(
    Schema.decodeUnknownSync(ApprovalDecision)(
      ApprovalDecision.cases.Allow.make({
        remember: true,
        dataScope: "server",
      })
    )
  ).toEqual(ApprovalDecision.cases.Allow.make({ remember: true, dataScope: "server" }));
  expect(DataRpcs.requests.has("data.approval.decide")).toBe(false);
});

test("F9: log preserves parameters, pending approval and an exclusive paging cursor", () => {
  const entry = Schema.decodeUnknownSync(QueryLogEntry)({
    ...log,
    params: [42],
    approval: { id: "approval1", status: "pending" },
  });

  expect(entry.params).toEqual([42]);
  expect(entry.approval).toEqual({ id: RequestId.make("approval1"), status: "pending" });
  expect(
    Schema.decodeUnknownSync(PageDataQueryLog.payloadSchema)({
      sessionId: "s1",
      before: "q1",
      limit: 100,
    })
  ).toMatchObject({ before: "q1", limit: 100 });
  expect(() =>
    Schema.decodeUnknownSync(PageDataQueryLog.payloadSchema)({ sessionId: "s1", limit: 101 })
  ).toThrow();
});

test.each(["keep", "clear", "set"])(
  "F10: edit/rename explicitly carries password action %s",
  (passwordAction) => {
    const input = {
      sessionId: "s1",
      ...source,
      name: "renamed",
      previousName: "app",
      passwordAction,
    };

    const payload = Schema.decodeUnknownSync(SaveDataSource.payloadSchema)(
      passwordAction === "set" ? { ...input, password: "new password" } : input
    );

    expect(payload.previousName).toBe("app");
    expect(payload.passwordAction).toBe(passwordAction);
  }
);

test("F11: schema completion receives columns and load time alongside returned/total counts", () => {
  const tree = Schema.decodeUnknownSync(SchemaTree)({
    loadedAt: "2026-10-30T00:00:00Z",
    truncatedTables: 0,
    schemas: [
      {
        name: "public",
        functions: [],
        views: [],
        tables: [
          {
            name: "invoices",
            rowEstimate: 18402,
            columnCount: 1,
            columns: [{ name: "id", type: "bigint" }],
          },
        ],
      },
    ],
  });

  expect(tree.schemas[0]?.tables[0]?.columns).toEqual([{ name: "id", type: "bigint" }]);
  expect(tree.loadedAt).toBe("2026-10-30T00:00:00Z");
});

test("F10: password actions reject ambiguous set/keep/clear combinations", () => {
  const input = { sessionId: "s", ...source };
  expect(() =>
    Schema.decodeUnknownSync(SaveDataSource.payloadSchema)({ ...input, passwordAction: "set" })
  ).toThrow();

  for (const passwordAction of ["keep", "clear"]) {
    expect(() =>
      Schema.decodeUnknownSync(SaveDataSource.payloadSchema)({
        ...input,
        passwordAction,
        password: "secret",
      })
    ).toThrow();
  }
});

test("F1: JSON escapes cannot hide a known credential in an innocuous nested value", () => {
  const value = DataValueTags.cases.Json.make({ text: JSON.stringify({ note: ['hun"ter2'] }) });
  expect(scrubDataValue(value, [Redacted.make('hun"ter2')])).toEqual(
    DataValueTags.cases.Json.make({ text: '{"note":["[redacted]"]}' })
  );
});
