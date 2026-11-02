import { expect, test } from "bun:test";
import { Effect, Match } from "effect";
import { TRACE_ID } from "../../traces/testing.ts";
import { source } from "./data.testing.ts";
import { context, makeSpan, NOW, turn, withStoredTools } from "./traces.testing.ts";
import { traceTools } from "./traces.ts";
import { unavailableSessions } from "../sessions/index.ts";
import { TEST_SESSION } from "../../traces/testing.ts";
import { SELF_CHECKOUT } from "../../traces/self/scope.ts";
import { WorkspaceId } from "@polaris/protocol";

const text = (result: Awaited<ReturnType<ReturnType<typeof traceTools>[number]["call"]>>) =>
  result.content[0]!.text;

const sid = (id: number) => id.toString(16).padStart(16, "0");

test("all Data bindings expose the read-only trace tools and enforce their exact input contracts", () =>
  withStoredTools(async (f) => {
    await f.ingest([makeSpan(1)]);

    for (const catalog of f.catalogs) {
      for (const name of ["traces", "trace", "span"]) {
        const tool = catalog.find((tool) => tool.name === name)!;
        expect(tool.annotations?.readOnlyHint).toBe(true);

        const input = Match.value(name).pipe(
          Match.when("traces", () => ({})),
          Match.when("trace", () => ({ id: TRACE_ID })),
          Match.orElse(() => ({ trace: TRACE_ID, span: sid(1) }))
        );

        expect((await tool.call(input)).isError).not.toBe(true);
      }
    }

    for (const input of [
      { limit: 51 },
      { limit: 0 },
      { minMs: -1 },
      { sessionId: "other" },
      { turn: 0 },
      { route: "a".repeat(257) },
    ])
      expect((await f.tool("traces").call(input)).structuredContent?.code).toBe("E-INPUT");
    expect((await f.tool("trace").call({ id: "1234" })).structuredContent?.code).toBe("E-INPUT");
    expect(
      (await f.tool("span").call({ trace: TRACE_ID, span: "bad" })).structuredContent?.code
    ).toBe("E-INPUT");
  }));

test("traces defaults to the current Turn and composes route glob, service, status and duration filters", () =>
  withStoredTools(async (f) => {
    await f.ingest([makeSpan(1)]);
    await f.ingest([makeSpan(1, undefined, "GET /old", 4, -61_000, "b".repeat(32))]);
    await f.ingest(
      [makeSpan(1, undefined, "POST /invoices/new", 90, 1, "c".repeat(32))],
      "billing"
    );
    await f.ingest(
      [makeSpan(1, undefined, "Other checkout", 80, 1, "d".repeat(32))],
      "ledger-api",
      "/different-checkout"
    );
    const current = await f.tool("traces").call({ limit: 1 });
    expect(text(current)).toBe(
      "Turn 12 · 2 traces (1 shown of 2; add limit or narrow filters)\ncccccccccccccccccccccccccccccccc  POST /invoices/new  billing  90 ms  1 spans  1 services"
    );
    expect(current.structuredContent?.traces).toEqual([
      {
        id: "c".repeat(32),
        root: "POST /invoices/new",
        service: "billing",
        durationMs: 90,
        spans: 1,
        services: ["billing"],
        errors: 0,
        turn,
        startedAt: new Date(Number(NOW / 1_000_000n) + 1).toISOString(),
      },
    ]);

    const filtered = await f.tool("traces").call({
      turn: "all",
      route: "POST /invoices*",
      service: "ledger-api",
      status: "ok",
      minMs: 100,
    });

    expect(text(filtered)).toContain(
      "All turns · 1 traces\n1234567890abcdef1234567890abcdef  POST /invoices/overdue  ledger-api  840 ms"
    );
    expect(text(filtered)).not.toContain("SLOW");
    expect(text(await f.tool("traces").call({ turn: "all" }))).toContain("All turns · 3 traces");
    expect(text(await f.tool("traces").call({ turn: 12, status: "error" }))).toBe(
      "Turn 12 · 0 traces"
    );
    expect((await f.tool("traces").call({ turn: 13 })).structuredContent?.code).toBe(
      "E-TRACE-NOT-FOUND"
    );
  }));

test("a stored 434-span trace collapses repeated siblings and their descendants into an N+1 summary", () =>
  withStoredTools(async (f) => {
    const spans = [makeSpan(1), makeSpan(2, 1, "invoices.recalculateOverdue", 814, 12)];

    for (let i = 0; i < 214; i++)
      spans.push(makeSpan(i + 3, 2, "GET fx-rates.internal/rates", 2.1, 60 + i * 2.1));
    await f.ingest(spans);
    await f.ingest(
      Array.from({ length: 214 }, (_, i) =>
        makeSpan(i + 217, i + 3, "GET /rates", 2, 61 + i * 2.1)
      ),
      "fx-rates"
    );
    await f.ingest(
      Array.from({ length: 4 }, (_, i) => makeSpan(i + 431, 2, `small ${i}`, 1, 700 + i))
    );
    const result = await f.tool("trace").call({ id: TRACE_ID.slice(0, 8) });
    expect(text(result)).toStartWith(
      "POST /invoices/overdue · 840 ms · 434 spans · ledger-api 220 (2.1 s), fx-rates 214 (428 ms) · turn 12 · 0 errors"
    );
    expect(text(result)).toContain(
      "+60 ms  449.4 ms      ×214 GET fx-rates.internal/rates  p50 2.1 ms  total 449.4 ms  (N+1?)"
    );
    expect(text(result)).toContain(
      "+61 ms  428 ms        ×214 GET /rates  fx-rates  p50 2 ms  total 428 ms"
    );
    expect(result.structuredContent?.folded).toEqual({ count: 0, underMs: 0 });
    expect(text(result).length).toBeLessThan(2500);
  }));

test("error paths retain exception type, message and the in-project frame before the critical path", () =>
  withStoredTools(async (f) => {
    const failed = makeSpan(4, 3, "calculate total", 5, 40);
    failed.status = { code: 2 };
    failed.events = [
      {
        name: "exception",
        timeUnixNano: failed.startTimeUnixNano,
        attributes: [
          { key: "exception.type", value: { stringValue: "AssertionError" } },
          { key: "exception.message", value: { stringValue: "expected 1200, got 0" } },
          {
            key: "exception.stacktrace",
            value: {
              stringValue: `at library (/vendor/node_modules/lib.js:1:1)\nat total (${context.checkout}/src/invoices.ts:22:3)`,
            },
          },
        ],
      },
    ];
    await f.ingest([
      makeSpan(1),
      makeSpan(2, 1, "slow sibling", 700, 10),
      makeSpan(3, 1, "error parent", 8, 39),
      failed,
    ]);
    const result = await f.tool("trace").call({ id: TRACE_ID });
    expect(text(result)).toContain(
      `calculate total  ERROR  span ${sid(4)}\n  AssertionError: expected 1200, got 0 · at total (${context.checkout}/src/invoices.ts:22:3)`
    );
    expect(text(result).indexOf("AssertionError:")).toBeGreaterThan(
      text(result).indexOf("slow sibling")
    );
    const errors = await f.tool("trace").call({ id: TRACE_ID, focus: "errors" });
    expect(text(errors)).toContain("error parent");
    expect(text(errors)).not.toContain("slow sibling");
    expect(errors.structuredContent?.folded).toEqual({ count: 1, underMs: 701 });
    const all = text(await f.tool("trace").call({ id: TRACE_ID, focus: "all" }));
    expect(all.indexOf("slow sibling")).toBeLessThan(all.indexOf("error parent"));
    expect(text(await f.tool("traces").call({ status: "error" }))).toContain(
      "1 ERROR: expected 1200, got 0"
    );
  }));

test("SLOW needs five earlier samples and uses the real median for the same root and parent/name pair", () =>
  withStoredTools(async (f) => {
    for (let i = 0; i < 4; i++)
      await f.ingest([
        makeSpan(
          1,
          undefined,
          "POST /invoices/overdue",
          100 + i * 10,
          -5000 + i * 100,
          (i + 1).toString().repeat(32)
        ),
        makeSpan(2, 1, "UPDATE invoices", 9, -4990 + i * 100, (i + 1).toString().repeat(32)),
      ]);
    await f.ingest([makeSpan(1), makeSpan(2, 1, "UPDATE invoices", 112, 702)]);
    expect(text(await f.tool("trace").call({ id: TRACE_ID }))).not.toContain("SLOW");
    await f.ingest([
      makeSpan(1, undefined, "POST /invoices/overdue", 1000, -3000, "5".repeat(32)),
      makeSpan(2, 1, "UPDATE invoices", 9, -2990, "5".repeat(32)),
    ]);
    const list = await f.tool("traces").call({ limit: 1 });
    expect(text(list)).toContain("SLOW (usually 120 ms)");
    expect(list.structuredContent?.traces).toMatchObject([{ slow: { usualMs: 120 } }]);
    expect(text(await f.tool("trace").call({ id: TRACE_ID }))).toContain(
      "UPDATE invoices  SLOW (usually 9 ms)"
    );
    await f.ingest([makeSpan(1, undefined, "POST /invoices/overdue", 1, 5000, "f".repeat(32))]);
    expect((await Effect.runPromise(f.store.history(context.checkout, TRACE_ID))).root).toBe(120);
  }));

test("cap overflow folds counted spans while keeping error paths and the critical path", () =>
  withStoredTools(async (f) => {
    const spans = [
      makeSpan(1),
      ...Array.from({ length: 300 }, (_, i) =>
        makeSpan(i + 2, 1, `step ${i} ${"detail ".repeat(20)}`, i === 299 ? 700 : 1, i / 100)
      ),
    ];

    spans[2]!.status = { code: 2 };
    await f.ingest(spans);
    const result = await f.tool("trace").call({ id: TRACE_ID });
    expect(text(result).length).toBeLessThanOrEqual(16_000);
    expect(text(result)).toContain("step 1 ");
    expect(text(result)).toContain("step 299 ");
    expect(text(result)).toMatch(/… \d+ spans under 2 ms folded; use span for details\./);
    expect(result.structuredContent?.folded).toMatchObject({ underMs: 2 });
    const listing = await f.tool("traces").call({ route: "no match" });
    expect(text(listing)).toBe("Turn 12 · 0 traces");
  }));

test("span exposes grouped redacted attributes, code, in-project exception frames, logs, links and matching Data Source", () =>
  withStoredTools(async (f) => {
    f.setSources([source]);
    const span = makeSpan(2, 1, "SELECT invoices", 30, 10);
    span.attributes.push(
      ...[
        ["db.system", "postgresql"],
        ["server.address", "localhost"],
        ["db.name", "ledger"],
        ["code.file.path", "src/invoices.ts"],
        ["code.line.number", "22"],
      ].map(([key, stringValue]) => ({ key: key!, value: { stringValue: stringValue! } }))
    );
    span.events = [
      {
        name: "exception",
        timeUnixNano: span.startTimeUnixNano,
        attributes: [
          {
            key: "exception.stacktrace",
            value: {
              stringValue: `at vendor (/node_modules/lib.js:1)\nat local (${context.checkout}/src/invoices.ts:22)`,
            },
          },
        ],
      },
    ];
    await f.ingest([makeSpan(1), span]);
    await Effect.runPromise(
      f.store.ingest({
        signal: "logs",
        contentType: "application/json",
        context,
        bytes: new TextEncoder().encode(
          JSON.stringify({
            resourceLogs: [
              {
                scopeLogs: [
                  {
                    logRecords: Array.from({ length: 25 }, (_, i) => ({
                      traceId: TRACE_ID,
                      spanId: sid(2),
                      timeUnixNano: (NOW + BigInt(i)).toString(),
                      body: { stringValue: `log ${i}` },
                    })),
                  },
                ],
              },
            ],
          })
        ),
      })
    );
    const result = await f.tool("span").call({ trace: TRACE_ID, span: sid(2) });
    expect(text(result)).toContain("SELECT invoices · server · ledger-api · ok · 30 ms");
    expect(text(result)).toContain("Offset: +10 ms · parent 0000000000000001");
    expect(text(result)).toContain("Data source: app · use describe or query");
    expect(f.sourceCalls()).toBe(1);
    expect(result.structuredContent?.dataSource).toEqual({ id: source.id, name: "app" });
    expect(text(result)).toContain("Code: src/invoices.ts:22");

    for (const name of ["attributes", "polaris", "resource", "scope", "events", "links"])
      expect(text(result)).toContain(`\n${name}\n`);
    expect(text(result)).toContain("authorization: [redacted]");
    expect(text(result)).toContain("logs · 20 of 25");
    expect(text(result)).toContain("5 older logs omitted");
    expect(text(result)).not.toContain("Launched turn:");
    expect(JSON.stringify(result)).not.toContain("private-");
    expect(text(result).indexOf("at local")).toBeLessThan(text(result).indexOf("at vendor"));
  }));

test("span and list cap overflow name omitted sections while structuredContent retains details", () =>
  withStoredTools(async (f) => {
    const span = makeSpan(1);
    span.attributes.push({ key: "huge", value: { stringValue: "z".repeat(25_000) } });
    await f.ingest([span]);
    const result = await f.tool("span").call({ trace: TRACE_ID, span: sid(1) });
    expect(text(result).length).toBeLessThanOrEqual(16_000);
    expect(text(result)).toContain(
      "… attributes: 1 detail lines folded; use span structuredContent for the full retained data."
    );
    expect(result.structuredContent?.span).toMatchObject({
      attributes: { huge: "z".repeat(25_000) },
    });
    await f.ingest([makeSpan(1, undefined, "huge " + "x".repeat(20_000), 30, 2, "a".repeat(32))]);
    const list = await f.tool("traces").call({});
    expect(text(list)).toContain("Turn 12 · 2 traces");
    expect(text(list)).toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(text(list)).toContain("value chars folded");
  }));

test("empty, ambiguous, missing and unavailable traces return actionable code/message/fix errors", () =>
  withStoredTools(async (f) => {
    const none = await f.tool("traces").call({});
    expect(none.isError).toBe(true);
    expect(none.structuredContent).toEqual({
      code: "E-TRACE-NONE",
      message: "No traces have reached this checkout.",
      fix: "Set up tracing in Traces (⌘5). Export to http://127.0.0.1:4319/otlp/test-endpoint.",
    });
    await f.ingest([
      makeSpan(1),
      makeSpan(1, undefined, "second", 12, 1, TRACE_ID.slice(0, 8) + "0".repeat(24)),
    ]);
    expect((await f.tool("trace").call({ id: TRACE_ID.slice(0, 8) })).structuredContent).toEqual({
      code: "E-TRACE-AMBIGUOUS",
      message: "The id prefix matches more than one trace or span.",
      fix: "Use a longer prefix or the full id.",
    });
    expect(
      (await f.tool("span").call({ trace: TRACE_ID, span: "eeeeeeee" })).structuredContent?.code
    ).toBe("E-TRACE-NOT-FOUND");
    f.setAvailable(false);

    for (const name of ["traces", "trace", "span"]) {
      const input = Match.value(name).pipe(
        Match.when("traces", () => ({})),
        Match.when("trace", () => ({ id: TRACE_ID })),
        Match.orElse(() => ({ trace: TRACE_ID, span: sid(1) }))
      );

      expect((await f.tool(name).call(input)).structuredContent?.code).toBe("E-TRACE-UNAVAILABLE");
    }

    const unavailable = traceTools(TEST_SESSION, unavailableSessions)[0]!;
    expect((await unavailable.call({})).structuredContent?.code).toBe("E-TRACE-UNAVAILABLE");
  }));

test("the critical chain uses the longest individual child before the aggregate of repeated calls", () =>
  withStoredTools(async (f) => {
    await f.ingest([
      makeSpan(1),
      ...Array.from({ length: 40 }, (_, group) =>
        Array.from({ length: 3 }, (_, member) =>
          makeSpan(
            2 + group * 3 + member,
            1,
            `repeated ${group} ${"x".repeat(500)}`,
            60,
            group + member
          )
        )
      ).flat(),
      makeSpan(124, 1, "longest child", 100, 130),
      makeSpan(125, 124, "critical leaf", 90, 135),
    ]);
    const result = text(await f.tool("trace").call({ id: TRACE_ID }));
    expect(result).toContain("longest child");
    expect(result).toContain("critical leaf");
    expect(result).toContain("spans under 61 ms folded");
  }));

test("long names and exception messages retain the error path and explicitly count clipped characters", () =>
  withStoredTools(async (f) => {
    const root = makeSpan(1, undefined, "root " + "x".repeat(18_000));
    const failed = makeSpan(2, 1, "error " + "y".repeat(18_000), 10, 1);
    failed.status = { code: 2 };
    failed.events = [
      {
        name: "exception",
        timeUnixNano: failed.startTimeUnixNano,
        attributes: [
          { key: "exception.message", value: { stringValue: "message " + "z".repeat(20_000) } },
        ],
      },
    ];
    failed.events = Array.from({ length: 30 }, () => failed.events[0]!);
    await f.ingest([root, failed]);
    const result = await f.tool("trace").call({ id: TRACE_ID });
    expect(text(result).length).toBeLessThanOrEqual(16_000);
    expect(text(result)).toContain("ERROR");
    expect(text(result)).toContain("29 exception events folded; use span for details.");
    expect(text(result)).toContain("exception message chars folded; use span structuredContent");
    expect(text(result)).toContain("header chars folded; use trace structuredContent");
    expect(result.structuredContent?.folded).toEqual({ count: 0, underMs: 0 });
  }));

test("collapsed descendants retain their earliest offset and all service names", () =>
  withStoredTools(async (f) => {
    await f.ingest([
      makeSpan(1),
      makeSpan(2, 1, "repeated parent", 600, 10),
      makeSpan(4, 2, "repeated child", 10, 300),
    ]);
    await f.ingest(
      [makeSpan(3, 1, "repeated parent", 600, 20), makeSpan(5, 3, "repeated child", 10, 50)],
      "fx-rates"
    );
    const result = text(await f.tool("trace").call({ id: TRACE_ID, focus: "all" }));
    expect(result).toContain(
      "+50 ms  20 ms      ×2 repeated child  fx-rates, ledger-api  p50 10 ms  total 20 ms"
    );
  }));

test("Polaris's own traces are readable with scope self only from the Polaris Workspace while Developer Mode is on", () =>
  withStoredTools(async (f) => {
    const selfTrace = "5".repeat(32);
    await f.ingest([makeSpan(1)]);
    await f.ingest(
      [makeSpan(7, undefined, "polaris.rpc.traces.get", 2, 0, selfTrace)],
      "polaris-daemon",
      SELF_CHECKOUT
    );

    const off = await f.tool("traces").call({ scope: "self" });
    expect(off.structuredContent?.code).toBe("E-TRACE-UNAVAILABLE");
    expect(off.structuredContent?.message).toBe(
      "Polaris's own traces are readable only from the Polaris Workspace while Developer Mode is on."
    );
    expect((await f.tool("trace").call({ id: selfTrace })).structuredContent?.code).toBe(
      "E-TRACE-NOT-FOUND"
    );

    // On, but this session's Workspace isn't the Polaris Workspace.
    f.setDeveloperMode(true, WorkspaceId.make("ws_other"));
    expect((await f.tool("traces").call({ scope: "self" })).structuredContent?.code).toBe(
      "E-TRACE-UNAVAILABLE"
    );
    expect((await f.tool("trace").call({ id: selfTrace })).structuredContent?.code).toBe(
      "E-TRACE-NOT-FOUND"
    );

    f.setDeveloperMode(true);
    const self = await f.tool("traces").call({ scope: "self" });
    expect(self.structuredContent?.traces).toMatchObject([
      { id: selfTrace, root: "polaris.rpc.traces.get", service: "polaris-daemon" },
    ]);
    expect(text(await f.tool("traces").call({ turn: "all" }))).not.toContain(selfTrace);

    // An id from the self list resolves without naming the scope; scope self skips the checkout.
    expect(text(await f.tool("trace").call({ id: selfTrace }))).toContain("polaris.rpc.traces.get");
    expect(text(await f.tool("span").call({ trace: selfTrace, span: sid(7) }))).toContain(
      "polaris.rpc.traces.get"
    );
    expect(
      (await f.tool("trace").call({ id: TRACE_ID, scope: "self" })).structuredContent?.code
    ).toBe("E-TRACE-NOT-FOUND");
  }));

test("an empty checkout points at scope self while Developer Mode is on", () =>
  withStoredTools(async (f) => {
    f.setDeveloperMode(true);

    expect((await f.tool("traces").call({})).structuredContent?.fix).toBe(
      "Set up tracing in Traces (⌘5). Export to http://127.0.0.1:4319/otlp/test-endpoint. For Polaris's own traces, pass scope self."
    );
    expect((await f.tool("traces").call({ scope: "self" })).structuredContent).toMatchObject({
      code: "E-TRACE-NONE",
      message: "No Self-Traces are kept yet.",
    });
  }));
