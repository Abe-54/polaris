import { join } from "node:path";
import { homedir } from "node:os";
import { expect, test } from "bun:test";
import { DataError, DataSource, DataValueTags, QueryResult, RequestId } from "@polaris/protocol";
import { Effect, Redacted } from "effect";
import { DataApprovalRequired } from "../../data/approvalRequired.ts";
import { knownFromConnection } from "../../data/knownCredentials.ts";
import { callClaudeTool } from "../../harness/claude/constellation.ts";
import { unavailableSessions } from "../sessions/index.ts";
import { dataTools, withDataApproval } from "./data.ts";
import { queryView, safeDataText } from "./dataFormat.ts";
import { result, resultFields, source, sourceFields, toolsWithData } from "./data.testing.ts";

const required = new DataApprovalRequired({
  approvalId: RequestId.make("approval"),
  sourceId: source.id,
  sourceName: source.name,
});

for (const [password, written, variants] of [
  ["hunter2-Secret!", "hunter2-Secret%21", ["hunter2-Secret%21"]],
  ["p@ss/w0rd!x", "p%40ss%2fw0rd%21x", ["p%40ss%2Fw0rd%21x", "p%40ss%2fw0rd%21x"]],
  ["qpSecret99", "ignored?password=qpSecret99", ["qpSecret99"]],
  ["20261030", "20261030", [20261030]],
  ["pw", "pw", ["pw"]],
] as const)
  test(`RM F2: selected password forms are scrubbed in cells and errors (${password.length} chars)`, async () => {
    const known = knownFromConnection(
      {
        hostname: "localhost",
        port: 5432,
        database: "db",
        username: "app",
        password: Redacted.make(password),
        tls: false,
      },
      Redacted.make(`postgres://app:${written}@localhost/db`)
    );

    for (const value of [password, ...variants]) {
      const tool = toolsWithData({
        credentials: () => Effect.succeed(known),
        query: () =>
          Effect.succeed(
            new QueryResult({
              ...resultFields,
              columns: [{ name: "note", type: "text" }],
              rows: [[value]],
              returned: 1,
              rowCount: 1,
            })
          ),
      })("query");

      const response = await tool.call({ source: "app", sql: "select note" });
      expect(JSON.stringify(response)).not.toContain(String(value));
      expect(response.structuredContent?.rows).toEqual([["[redacted]"]]);
    }

    const response = await toolsWithData({
      credentials: () => Effect.succeed(known),
      query: () =>
        Effect.fail(
          new DataError({ code: "E-DATA-SQL", message: `syntax near '${password}'`, fix: "Retry" })
        ),
    })("query").call({ source: "app", sql: "select note" });

    expect(JSON.stringify(response)).not.toContain(password);
  });

test("RM F3: hostile scheme candidates are clipped before bounded scanning", () => {
  const start = performance.now();
  expect(safeDataText("a.".repeat(200_000)).length).toBeLessThanOrEqual(32_000);
  expect(performance.now() - start).toBeLessThan(250);
});

for (const input of [
  "PGPASSWORD=other-private",
  "MYSQL_PWD=other-private",
  '{"password":"other-private"}',
  "app:other-private@host/db",
  "mysql -pother-private",
  "postgres://app:other'private@host/db",
  "postgres://app:other private@host/db",
])
  test(`RM F6: a credential value in ${JSON.stringify(input)} is scrubbed from text`, () => {
    expect(safeDataText(input)).not.toContain("private");
    expect(safeDataText(input)).not.toContain("other");
  });

test("RM F4/F9: both outputs cap at 16k and keep a shared summary, counts and whole rows", () => {
  const view = queryView(
    new QueryResult({
      ...resultFields,
      returned: 200,
      rowCount: 200,
      total: 18402,
      truncated: true,
      columns: [{ name: "body", type: "text" }],
      rows: Array.from({ length: 200 }, () => ["x".repeat(200)]),
    })
  );

  expect(view.text.length).toBeLessThanOrEqual(16000);
  expect(JSON.stringify(view.data).length).toBeLessThanOrEqual(16000);
  const [header, tail] = view.data.summary.split("\n");
  expect(view.text.startsWith(header!)).toBe(true);
  expect(view.text.endsWith(tail!)).toBe(true);
  expect(view.data.total).toBe(18402);
  expect(view.data.returned).toBe(view.data.rows.length);
  expect(view.data.rows.length).toBeGreaterThan(0);
  expect(view.data.rows.length).toBeLessThan(200);
});

test("RM F9: a late wide JSON cell and wide column names cannot wipe every row", () => {
  const view = queryView(
    new QueryResult({
      ...resultFields,
      columns: [{ name: "n".repeat(14000), type: "json" }],
      rows: [
        ["small"],
        [DataValueTags.cases.Json.make({ text: JSON.stringify({ value: "x".repeat(60000) }) })],
      ],
      returned: 2,
    })
  );

  expect(view.data.rows.length).toBe(2);
  expect(view.data.columns[0]!.name.length).toBeLessThan(230);
  expect(JSON.stringify(view.data.rows[1]![0]).length).toBeLessThan(230);
});

test("RM F10: ANSI and controls disappear; newlines in identifiers remain escaped", () => {
  const view = queryView(
    new QueryResult({
      ...resultFields,
      columns: [{ name: "line\nname\t\r\u001b[31m", type: "text" }],
      rows: [["a\u0000b\u001b[0m\nnext"]],
      returned: 1,
    })
  );

  expect(view.data.columns[0]!.name).toBe(String.raw`line\nname\t\r`);
  expect(view.data.rows).toEqual([[String.raw`ab\nnext`]]);
});

test('RM F11: a one-row result says "1 row", and a result cut by the limit hints at the limit, not the columns', () => {
  const single = queryView(
    new QueryResult({ ...resultFields, returned: 1, rows: [[1]], truncated: true })
  );

  expect(single.text).toContain("1 row ·");
  expect(single.text).toContain("increase the limit");
  expect(single.text).not.toContain("select fewer columns");
});

test("RM F12: missing service and invalid input errors have no graph tail", async () => {
  const unavailable = dataTools(sourceSession(), unavailableSessions).find(
    (tool) => tool.name === "query"
  )!;

  const missing = await unavailable.call({ source: "app", sql: "select 1" });
  expect(missing.structuredContent?.code).toBe("E-NOT-READY");
  expect(JSON.stringify(missing)).not.toMatch(/Revision:|Next:|graph changed/);

  const response = await toolsWithData()("query").call({
    source: "app",
    sql: "select 1",
    limit: 201,
  });

  expect(response.structuredContent?.code).toBe("E-INPUT");
  expect(JSON.stringify(response)).not.toMatch(/Revision:|Next:|graph changed/);
});

test("RM F14: only exact credential column names are redacted", () => {
  const names = [
    "password",
    "passwd",
    "secret",
    "token",
    "api_key",
    "token_count",
    "password_reset_at",
    "secretary",
  ];

  const view = queryView(
    new QueryResult({
      ...resultFields,
      columns: names.map((name) => ({ name, type: "text" })),
      rows: [names.map(() => "visible")],
      returned: 1,
    })
  );

  expect(view.data.rows).toEqual([
    [
      "[redacted]",
      "[redacted]",
      "[redacted]",
      "[redacted]",
      "[redacted]",
      "visible",
      "visible",
      "visible",
    ],
  ]);
});

test("RM F7: abort interrupts the approval wait and never reruns the Query", async () => {
  let calls = 0;
  let waiting!: () => void;
  let interrupted = false;

  const started = new Promise<void>((resolve) => {
    waiting = resolve;
  });

  const tool = toolsWithData({
    query: () =>
      Effect.suspend(() => {
        calls++;

        return Effect.fail(required);
      }),
    awaitApproval: () =>
      Effect.gen(function* () {
        waiting();

        return yield* Effect.never;
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true;
          })
        )
      ),
  })("query");

  const controller = new AbortController();

  const request = callClaudeTool(
    tool,
    { source: "app", sql: "select 1" },
    { signal: controller.signal }
  );

  await started;
  controller.abort();
  expect(
    await request.then(
      () => false,
      () => true
    )
  ).toBe(true);
  expect(interrupted).toBe(true);
  expect(calls).toBe(1);
});

for (const operation of ["query", "execute"] as const)
  test(`RM F8: a late ${operation} approval returns success without executing again`, async () => {
    let calls = 0;

    const run = Effect.suspend(() => {
      calls++;

      return Effect.fail(required);
    });

    const data = {
      sources: () => Effect.succeed({ checkout: "/tmp", sources: [] }),
      credentials: () => Effect.succeed([]),
      describe: () => Effect.succeed(result),
      query: () => Effect.succeed(result),
      execute: () => Effect.fail(required),
      awaitApproval: () => Effect.succeed({ status: "approved" as const }),
    };

    const response = await Effect.runPromise(
      withDataApproval(
        run,
        { ...data, describe: () => Effect.fail(required) },
        () => ({ content: [] }),
        sourceSession(),
        Date.now() - 26000,
        [],
        operation
      )
    );

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent?.approved).toBe(true);
    expect(response.content[0]!.text).toContain(`call ${operation} again`);
    expect(calls).toBe(1);
  });

import { plainBinding } from "./data.testing.ts";

const sourceSession = () => plainBinding.sessionId;

test("unprobed sources omit reachable without reporting down", async () => {
  const { reachable: _reachable, ...unprobed } = sourceFields;

  const response = await toolsWithData({
    sources: () => Effect.succeed({ checkout: "/tmp", sources: [new DataSource(unprobed)] }),
  })("data_sources").call({});

  expect(response.structuredContent?.sources).toEqual([
    expect.not.objectContaining({ reachable: false }),
  ]);
  expect(JSON.stringify(response)).not.toContain("down");
});

test("RM F2/F3: a secret crossing the bounded input window cannot leak its prefix", () => {
  const secret = "s".repeat(40_000);

  const view = queryView(
    new QueryResult({
      ...resultFields,
      columns: [{ name: "note", type: "text" }],
      rows: [[secret]],
      returned: 1,
    }),
    [Redacted.make(secret)]
  );

  expect(view.data.rows).toEqual([["[redacted]"]]);
  expect(view.text).not.toContain("ssss");
});

test.each([`${homedir()}/code/ledger`, join(homedir(), "code", "ledger")])(
  "RM F11: source checkout copy abbreviates the user home: %s",
  async (checkout) => {
    const response = await toolsWithData({
      sources: () => Effect.succeed({ checkout, sources: [source] }),
    })("data_sources").call({});

    expect(response.content[0]!.text).toContain("1 data source in ~/code/ledger");
  }
);

test("an approved retry forwards only the internal approval id", async () => {
  let attempts = 0;

  const tools = toolsWithData({
    query: (input) =>
      Effect.suspend(() => {
        attempts++;

        return input.approvalId === required.approvalId
          ? Effect.succeed(result)
          : Effect.fail(required);
      }),
    awaitApproval: () => Effect.succeed({ status: "approved" }),
  });

  const done = await tools("query").call({ source: "app", sql: "select 1" });
  expect(done.structuredContent?.queryId).toBe(result.queryId);
  expect(attempts).toBe(2);

  const forged = await tools("query").call({
    source: "app",
    sql: "select 1",
    approvalId: required.approvalId,
  });

  expect(forged.structuredContent?.code).toBe("E-INPUT");
  expect(attempts).toBe(2);
});

test("source checkout copy respects native backslash semantics", async () => {
  const response = await toolsWithData({
    sources: () => Effect.succeed({ checkout: join(homedir(), "code\\ledger"), sources: [source] }),
  })("data_sources").call({});

  expect(response.content[0]!.text).toContain(
    process.platform === "win32"
      ? "1 data source in ~/code/ledger"
      : "1 data source in ~/code\\ledger"
  );
});
