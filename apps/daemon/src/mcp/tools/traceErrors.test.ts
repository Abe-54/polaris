import { expect, test } from "bun:test";
import { WorkspaceId } from "@polaris/protocol";
import { SELF_CHECKOUT } from "../../traces/self/scope.ts";
import { makeSpan, NOW, withStoredTools } from "./traces.testing.ts";

const trace = (n: number) => n.toString(16).padStart(32, "0");

const sid = (id: number) => id.toString(16).padStart(16, "0");

const MINUTE = 60_000;

const at = (minutes: number) => new Date(Number(NOW / 1_000_000n) + minutes * MINUTE).toISOString();

const failed = (span: ReturnType<typeof makeSpan>, message: string) => ({
  ...span,
  status: { code: 2, message },
});

test("trace_errors groups error spans by fingerprint with an example, counts, first and last seen, services and names", () =>
  withStoredTools(async (f) => {
    await f.ingest([
      failed(
        makeSpan(1, undefined, "data.describe", 5, -9 * MINUTE, trace(1)),
        "DataError: branch 7mmvvc5m9g0t does not exist\n    at ws (/$bunfs/root/chunk.js:19:4571)"
      ),
    ]);
    await f.ingest(
      [
        failed(
          makeSpan(2, undefined, "data.query", 5, -5 * MINUTE, trace(2)),
          "DataError: branch q2w8e4r1t6y9 does not exist"
        ),
      ],
      "worker"
    );
    await f.ingest([
      failed(
        makeSpan(3, undefined, "data.describe", 5, -2 * MINUTE, trace(3)),
        "DataError: branch z9x8c7v6b5n4 does not exist"
      ),
    ]);
    await f.ingest([
      failed(
        makeSpan(4, undefined, "data.query", 5, -1 * MINUTE, trace(4)),
        `syntax error at or near "'User'"`
      ),
    ]);
    // Outside the default hour, and an ok span: neither is read.
    await f.ingest([failed(makeSpan(5, undefined, "old", 5, -90 * MINUTE, trace(5)), "old")]);
    await f.ingest([makeSpan(6, undefined, "fine", 5, -1 * MINUTE, trace(6))]);

    const result = await f.tool("trace_errors").call({});

    expect(result.structuredContent).toMatchObject({ spans: 4, groupCount: 2, truncated: false });
    expect(result.structuredContent?.fingerprints).toEqual([
      {
        fingerprint: "DataError: branch <id> does not exist",
        message: "DataError: branch z9x8c7v6b5n4 does not exist",
        count: 3,
        firstSeen: at(-9),
        lastSeen: at(-2),
        services: [
          { value: "ledger-api", count: 2 },
          { value: "worker", count: 1 },
        ],
        names: [
          { value: "data.describe", count: 2 },
          { value: "data.query", count: 1 },
        ],
        nameCount: 2,
        example: { trace: trace(3), span: sid(3) },
      },
      expect.objectContaining({ fingerprint: "syntax error at or near <str>", count: 1 }),
    ]);
    expect(result.content[0]!.text).toContain(
      "×3  DataError: branch <id> does not exist\n  e.g. DataError: branch z9x8c7v6b5n4 does not exist\n"
    );

    const narrowed = await f.tool("trace_errors").call({ service: "worker", sinceMinutes: 120 });
    expect(narrowed.structuredContent?.fingerprints).toMatchObject([
      { count: 1, example: { trace: trace(2) } },
    ]);

    const old = await f.tool("trace_errors").call({ name: "OLD", sinceMinutes: 120 });
    expect(old.structuredContent?.fingerprints).toMatchObject([{ fingerprint: "old", count: 1 }]);

    const none = await f.tool("trace_errors").call({ sinceMinutes: 1 });
    expect(none.content[0]!.text).toEndWith(
      "(last 1 min) · none. Widen sinceMinutes or loosen name or service."
    );
  }));

test("trace_errors scope self follows the Self-Trace rule and reads only Self-Traces", () =>
  withStoredTools(async (f) => {
    await f.ingest([failed(makeSpan(1, undefined, "checkout.span"), "checkout failure")]);
    await f.ingest(
      [failed(makeSpan(7, undefined, "polaris.rpc.files.read", 2, 0, trace(7)), "ENOENT 12")],
      "polaris-daemon",
      SELF_CHECKOUT
    );

    expect((await f.tool("trace_errors").call({ scope: "self" })).structuredContent?.code).toBe(
      "E-TRACE-UNAVAILABLE"
    );

    f.setDeveloperMode(true, WorkspaceId.make("ws_other"));
    expect((await f.tool("trace_errors").call({ scope: "self" })).structuredContent?.code).toBe(
      "E-TRACE-UNAVAILABLE"
    );

    f.setDeveloperMode(true);
    expect(
      (await f.tool("trace_errors").call({ scope: "self" })).structuredContent?.fingerprints
    ).toMatchObject([{ fingerprint: "ENOENT <n>", services: [{ value: "polaris-daemon" }] }]);
    expect((await f.tool("trace_errors").call({})).structuredContent?.fingerprints).toMatchObject([
      { fingerprint: "checkout failure" },
    ]);
  }));
