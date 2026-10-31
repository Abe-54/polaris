import { expect, test } from "bun:test";
import {
  DataError,
  DataValueTags,
  QueryResult,
  RequestId,
  SchemaTree,
  TableDetail,
} from "@polaris/protocol";
import { Effect, Redacted } from "effect";
import { DataApprovalRequired } from "../../data/approvalRequired.ts";
import {
  bindings,
  result,
  resultFields,
  source,
  table,
  tableFields,
  toolsWithData,
} from "./data.testing.ts";

for (const binding of bindings)
  test(`${binding._tag} has read-only Data tools with bound identity`, async () => {
    let caller = "";

    const tool = toolsWithData(
      {
        query: (input) => {
          caller = input.sessionId;

          return Effect.succeed(result);
        },
      },
      binding
    );

    for (const name of ["data_sources", "describe", "query"])
      expect(tool(name).annotations?.readOnlyHint).toBe(true);
    await tool("query").call({ source: "app", sql: "select 1" });
    expect(caller).toBe(binding.sessionId);

    for (const input of [
      { sessionId: "other" },
      { turn: "other" },
      { url: "postgres://other" },
      { path: "/other" },
    ]) {
      expect((await tool("query").call({ source: "app", sql: "select 1", ...input })).isError).toBe(
        true
      );
      expect((await tool("data_sources").call(input)).isError).toBe(true);
      expect((await tool("describe").call({ source: "app", ...input })).isError).toBe(true);
    }
  });

test("data_sources lists provenance and access without internal fields or credentials", async () => {
  const response = await toolsWithData()("data_sources").call({});
  expect(response.content[0]?.text).toBe(
    "1 data source in ~/code/ledger\napp  postgres 16.4  local  localhost:5432/ledger  from .env.local (DATABASE_URL)  read · writes ask you"
  );
  expect(response.structuredContent?.sources).toEqual([
    {
      name: "app",
      engine: "postgres",
      version: "16.4",
      locality: "local",
      host: "localhost",
      port: 5432,
      database: "ledger",
      foundIn: source.foundIn,
      access: "read",
      writes: "ask",
      reachable: true,
    },
  ]);
});

test("describe renders table details as the contract example and schema names, views and functions", async () => {
  const tool = toolsWithData()("describe");
  const response = await tool.call({ source: "app", table: "public.invoices" });
  expect(response.content[0]?.text).toBe(
    "public.invoices  ~18,402 rows\n  id           uuid         not null  pk  default gen_random_uuid()\n  customer_id  uuid         not null  → public.customers.id\n  total_cents  bigint       not null\n  due_at       timestamptz  null\nindexes: invoices_pkey (id), invoices_due_at_idx (due_at)"
  );
  expect(response.structuredContent?.columns).toEqual(table.columns);
  const schema = await tool.call({ source: "app" });
  expect(schema.content[0]?.text).toBe(
    "public\n  invoices  ~18,402 rows  4 columns\n  view overdue  unknown rows  2 columns\n  function invoice_total"
  );
});

test("query binds params and limit, preserving NULL and database numerics in aligned output", async () => {
  let received: unknown;

  const response = await toolsWithData({
    query: (input) => {
      received = input;

      return Effect.succeed(result);
    },
  })("query").call({
    source: "app",
    sql: "select * from invoices where id = $1",
    params: [1],
    limit: 2,
  });

  expect(received).toMatchObject({ source: "app", params: [1], limit: 2 });
  expect(response.content[0]?.text).toBe(
    "2 rows · 34 ms · query q_7f3a\nid (int4)  total (numeric)\n1          12.3400\n2          NULL"
  );
  expect(response.structuredContent).toEqual({
    queryId: "q_7f3a",
    summary: "2 rows · 34 ms · query q_7f3a",
    returned: 2,
    columns: [
      { name: "id", type: "int4" },
      { name: "total", type: "numeric" },
    ],
    rows: [
      [1, "12.3400"],
      [2, null],
    ],
    rowCount: 2,
    truncated: false,
    elapsedMs: 34,
  });
});

test("invalid sample and limit fail before execution", async () => {
  const tools = toolsWithData({
    query: () => {
      throw new Error("must not execute");
    },
    describe: () => {
      throw new Error("must not execute");
    },
  });

  for (const limit of [0, 201, 1.5])
    expect((await tools("query").call({ source: "app", sql: "select 1", limit })).isError).toBe(
      true
    );

  for (const sample of [-1, 21, 1.5])
    expect(
      (await tools("describe").call({ source: "app", table: "invoices", sample })).isError
    ).toBe(true);
});

test("query values and samples redact URLs, passwords and tokens before clipping in both outputs", async () => {
  const values = new QueryResult({
    queryId: "q_safe",
    columns: [
      { name: "url", type: "text" },
      { name: "password", type: "text" },
      { name: "json", type: "json" },
      { name: "binary", type: "bytea" },
      { name: "at", type: "timestamptz" },
      { name: "long", type: "text" },
    ],
    rows: [
      [
        "postgres://owner:top-secret@db/app",
        "top-secret",
        DataValueTags.cases.Json.make({
          text: '{"token":"nested-secret","link":"https://private.example/?token=secret"}',
        }),
        DataValueTags.cases.Bytes.make({ length: 3 }),
        DataValueTags.cases.Timestamp.make({ iso: "2026-01-01T00:00:00.000Z" }),
        "x".repeat(250),
      ],
    ],
    rowCount: 1,
    returned: 1,
    elapsedMs: 1,
    truncated: false,
  });

  const tools = toolsWithData({
    query: () => Effect.succeed(values),
    describe: () => Effect.succeed(new TableDetail({ ...tableFields, sample: values })),
  });

  for (const name of ["query", "describe"]) {
    const response = await tools(name).call(
      name === "query"
        ? { source: "app", sql: "select *" }
        : { source: "app", table: "invoices", sample: 1 }
    );

    const json = JSON.stringify(response);

    for (const secret of ["://", "top-secret", "nested-secret", "private.example"])
      expect(json).not.toContain(secret);
    expect(json).toContain("<bytes 3>");
    expect(json).toContain("2026-01-01T00:00:00.000Z");
    expect(json).toContain("…(+50 chars)");
  }
});

for (const code of [
  "E-DATA-UNKNOWN-SOURCE",
  "E-DATA-UNREACHABLE",
  "E-DATA-DENIED",
  "E-DATA-READ-ONLY",
  "E-DATA-TIMEOUT",
  "E-DATA-SQL",
] as const)
  test(`${code} preserves safe database details and sanitizes credentials`, async () => {
    const response = await toolsWithData({
      query: () =>
        Effect.fail(
          new DataError({
            code,
            message: "position 12: postgres://u:secret@db/app password=other-secret",
            fix: "narrow the query",
          })
        ),
    })("query").call({ source: "app", sql: "select 1" });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual({
      code,
      message: "position 12: [redacted URL] password=[redacted]",
      fix: "narrow the query",
    });
  });

test("query drops complete rows under 16k, with the count and a useful next action", async () => {
  const response = await toolsWithData({
    query: () =>
      Effect.succeed(
        new QueryResult({
          ...resultFields,
          columns: [{ name: "body", type: "text" }],
          rows: Array.from({ length: 200 }, () => ["x".repeat(200)]),
          rowCount: 200,
          returned: 200,
          total: 18402,
          truncated: true,
        })
      ),
  })("query").call({ source: "app", sql: "select body from invoices" });

  const content = response.content[0]!.text;
  expect(content.length).toBeLessThanOrEqual(16000);
  expect(content).toMatch(/\n\d+ of 18,402 rows; select fewer columns$/);
  expect(response.structuredContent?.truncated).toBe(true);
});

test("describe caps tables at 500 and says how to fetch omitted tables", async () => {
  const schemas = [
    {
      name: "public",
      tables: Array.from({ length: 502 }, (_, i) => ({
        name: `t${i}`,
        columnCount: 1,
        columns: [{ name: "id", type: "int4" }],
        rowEstimate: 0,
      })),
      views: [],
      functions: [],
    },
  ];

  const response = await toolsWithData({
    describe: () =>
      Effect.succeed(
        new SchemaTree({ schemas, truncatedTables: 3, loadedAt: "2026-10-30T00:00:00Z" })
      ),
  })("describe").call({ source: "app" });

  expect(response.content[0]?.text).toContain("5 more tables; describe a table by name");
  expect(response.content[0]?.text).not.toContain("t500");
  expect(response.structuredContent?.truncatedTables).toBe(5);
});

for (const name of ["query", "describe"])
  test(`${name} pending approval survives retry, then approval executes`, async () => {
    let approved = false;
    let waits = 0;

    const required = new DataApprovalRequired({
      approvalId: RequestId.make("approval-1"),
      sourceId: source.id,
      sourceName: source.name,
    });

    const tools = toolsWithData({
      query: () =>
        Effect.suspend(() => (approved ? Effect.succeed(result) : Effect.fail(required))),
      describe: () =>
        Effect.suspend(() => (approved ? Effect.succeed(table) : Effect.fail(required))),
      awaitApproval: (_id, timeoutMs) => {
        expect(timeoutMs).toBeGreaterThan(54000);
        expect(timeoutMs).toBeLessThanOrEqual(55000);
        waits++;

        return Effect.succeed({ status: "pending" });
      },
    });

    const input =
      name === "query" ? { source: "app", sql: "select 1" } : { source: "app", table: "invoices" };

    for (let retry = 0; retry < 2; retry++) {
      const pending = await tools(name).call(input);
      expect(pending.isError).not.toBe(true);
      expect(pending.content[0]?.text).toBe(
        "Waiting for the user to approve app in this conversation; call again after they answer"
      );
      expect(pending.structuredContent).toEqual({ pending: true, approvalId: "approval-1" });
    }

    approved = true;
    const done = await tools(name).call(input);
    expect(done.content[0]?.text).toContain(name === "query" ? "query q_7f3a" : "public.invoices");
    expect(waits).toBe(2);
  });

test("an answered approval executes in the same call and denial returns the user's reason", async () => {
  let approved = false;

  const required = new DataApprovalRequired({
    approvalId: RequestId.make("approval-2"),
    sourceId: source.id,
    sourceName: source.name,
  });

  const query = () =>
    Effect.suspend(() => (approved ? Effect.succeed(result) : Effect.fail(required)));

  const response = await toolsWithData({
    query,
    awaitApproval: () => {
      approved = true;

      return Effect.succeed({ status: "approved" });
    },
  })("query").call({ source: "app", sql: "select 1" });

  expect(response.structuredContent?.queryId).toBe(result.queryId);
  approved = false;

  const denied = await toolsWithData({
    query,
    awaitApproval: () => Effect.succeed({ status: "denied", reason: "Use staging" }),
  })("query").call({ source: "app", sql: "select 1" });

  expect(denied.isError).toBe(true);
  expect(denied.structuredContent?.code).toBe("E-DATA-DENIED");
  expect(denied.content[0]?.text).toContain("Use staging");
});

test("bare source passwords in innocuous cells and SQL errors are scrubbed before clipping", async () => {
  const password = "source-private-password";
  const credentials = () => Effect.succeed([Redacted.make(password)]);
  const cell = `${"a".repeat(195)}${password}${"z".repeat(20)}`;

  const response = await toolsWithData({
    credentials,
    query: () =>
      Effect.succeed(
        new QueryResult({
          ...resultFields,
          columns: [{ name: "note", type: "text" }],
          rows: [[cell]],
          rowCount: 1,
        })
      ),
  })("query").call({ source: "app", sql: "select note" });

  expect(JSON.stringify(response)).not.toContain(password);
  expect(JSON.stringify(response)).not.toContain("source-private");
  expect(JSON.stringify(response)).toContain("[reda");

  const error = await toolsWithData({
    credentials,
    query: () =>
      Effect.fail(
        new DataError({
          code: "E-DATA-SQL",
          message: `bad syntax near '${password}' at position 5`,
          fix: "Fix SQL",
        })
      ),
  })("query").call({ source: "app", sql: "select note" });

  expect(error.structuredContent?.message).toBe("bad syntax near '[redacted]' at position 5");
});

test("RRV F7: a denied write keeps the reason and permits another approach with a fresh preview", async () => {
  const required = new DataApprovalRequired({
    approvalId: RequestId.make("denied-write"),
    sourceId: source.id,
    sourceName: source.name,
  });

  const response = await toolsWithData({
    execute: () => Effect.fail(required),
    awaitApproval: () => Effect.succeed({ status: "denied", reason: "Use EUR instead of USD" }),
  })("execute").call({
    source: "app",
    sql: "UPDATE invoices SET currency=$1",
    params: ["USD"],
    reason: "Repair currency",
  });

  expect(response.structuredContent).toEqual({
    code: "E-DATA-DENIED",
    message: "Use EUR instead of USD",
    fix: "Read the user's reason; try another way with a new preview, or ask the user.",
  });
});
