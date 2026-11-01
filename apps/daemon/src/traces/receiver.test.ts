import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent, request } from "node:http";
import { Effect } from "effect";
import { TurnId, TraceTurn } from "@polaris/protocol";
import {
  postTraces,
  spanFixture,
  traceFixture,
  TEST_SESSION,
  TRACE_ID,
  SPAN_ID,
  withTraceFixture,
} from "./testing.ts";

test("JSON ingest stores exact times, redacts every surface and attributes by Span start", () =>
  withTraceFixture(async (f) => {
    const start = (BigInt(Date.now() - 2000) * 1000000n + 123n).toString();
    f.state.turns = [
      {
        turn: TraceTurn.make({ sessionId: TEST_SESSION, id: TurnId.make("turn-1"), number: 1 }),
        start: (BigInt(start) - 1000000n).toString(),
        end: (BigInt(start) + 1000000000n).toString(),
      },
    ];
    const response = await postTraces(f.endpoint!, traceFixture([spanFixture({ start })]));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    const page = await Effect.runPromise(f.store.list(f.root));
    expect(page.total).toBe(1);
    expect(page.traces[0]?.root).toBe("POST /orders");
    const detail = await Effect.runPromise(f.store.get(f.root, TRACE_ID.slice(0, 8)));
    expect(detail.spans[0]?.startTimeUnixNano).toBe(start);
    expect(detail.spans[0]?.durationMs).toBe(12.345678);
    expect(detail.spans[0]?.attributes.large).toBe("9223372036854775807");
    expect(detail.spans[0]?.polaris.turn?.number).toBe(1);
    expect(detail.spans[0]?.polaris.launchedTurn).toBeNull();
    expect(detail.spans[0]?.attributes["http.request.header.authorization"]).toBe("[redacted]");
    expect(detail.spans[0]?.resource.token).toBe("[redacted]");
    expect(detail.spans[0]?.scope.attributes.secret).toBe("[redacted]");
    expect(detail.spans[0]?.events[0]?.attributes["exception.message"]).toBe("[redacted]");
    expect(detail.spans[0]?.links[0]?.attributes.cookie).toBe("[redacted]");
    expect(detail.spans[0]?.attributes.nested).toEqual({ apiKey: "[redacted]" });
    expect(JSON.stringify(detail)).not.toContain("private-");
    expect((await readFile(join(f.root, "traces.sqlite"))).includes(Buffer.from("private-"))).toBe(
      false
    );

    const next = await postTraces(
      f.endpoint!,
      traceFixture([spanFixture({ traceId: "abcdef1234567890abcdef1234567890" })])
    );

    expect(next.status).toBe(200);
    const between = await Effect.runPromise(f.store.get(f.root, "abcdef12"));
    expect(between.spans[0]?.polaris.turn).toBeNull();
  }));

test("unknown, revoked and ended-session tokens cannot ingest; Host and any Origin are refused", () =>
  withTraceFixture(async (f) => {
    const send = (url: string, headers: Record<string, string> = {}) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: "{}",
      });

    expect((await send(`http://127.0.0.1:${f.port}/otlp/${"f".repeat(64)}/v1/traces`)).status).toBe(
      401
    );
    expect(
      (await send(`${f.endpoint}/v1/traces`, { host: `attacker.test:${f.port}` })).status
    ).toBe(403);
    expect(
      (await send(`${f.endpoint}/v1/traces`, { host: `127.0.0.1:${f.port + 1}` })).status
    ).toBe(403);

    for (const origin of ["null", "https://attacker.test", `http://127.0.0.1:${f.port}`])
      expect((await send(`${f.endpoint}/v1/traces`, { origin })).status).toBe(403);
    expect((await send(`${f.endpoint}/v1/traces`, { host: `localhost:${f.port}` })).status).toBe(
      200
    );
    await Effect.runPromise(f.runtime.revokeSession(TEST_SESSION));
    expect((await send(`${f.endpoint}/v1/traces`)).status).toBe(401);
    const next = await Effect.runPromise(f.runtime.environment(TEST_SESSION, {}));
    f.state.active = false;
    expect((await send(`${next.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`)).status).toBe(401);
    expect((await Effect.runPromise(f.store.list(f.root))).total).toBe(0);
  }));

test("refusals close connections and a subsequent valid request succeeds", () =>
  withTraceFixture(async (f) => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const ports: Array<number | undefined> = [];

    const send = (path: string, type: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          `${f.endpoint}${path}`,
          { method: "POST", headers: { "content-type": type }, agent },
          (res) => {
            ports.push(res.socket?.localPort);
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          }
        );

        req.on("error", reject);
        req.end(JSON.stringify(traceFixture()));
      });

    try {
      expect(await send("/v1/traces", "text/plain")).toBe(415);
      expect(await send("/wrong", "application/json")).toBe(404);
      expect(await send("/v1/traces", "application/json")).toBe(200);
      expect(new Set(ports).size).toBe(3);
      expect((await Effect.runPromise(f.store.get(f.root, TRACE_ID))).spans[0]?.id).toBe(SPAN_ID);
    } finally {
      agent.destroy();
    }
  }));

test("oversized, malformed and compressed bodies are refused without writing records", () =>
  withTraceFixture(async (f) => {
    const send = (body: string | Uint8Array, headers: Record<string, string>) =>
      fetch(`${f.endpoint}/v1/traces`, { method: "POST", headers, body });

    // Wait for refusal before uploading: Windows resets a sender still writing a rejected body.
    const oversized = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${f.endpoint}/v1/traces`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "content-length": 4 * 1024 * 1024 + 1 },
        },
        (res) => {
          res.resume();
          res.once("end", () => {
            req.destroy();
            resolve(res.statusCode ?? 0);
          });
        }
      );

      req.once("error", reject);
      req.end();
    });

    expect(oversized).toBe(413);
    expect((await send("{", { "content-type": "application/json" })).status).toBe(400);
    expect(
      (await send(new Uint8Array([10, 255]), { "content-type": "application/x-protobuf" })).status
    ).toBe(400);
    expect(
      (await send("{}", { "content-type": "application/json", "content-encoding": "gzip" })).status
    ).toBe(415);
    expect((await Effect.runPromise(f.store.list(f.root))).total).toBe(0);
  }));

test("a port conflict leaves the owner running and exposes an unavailable state", async () => {
  const owner = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("owner still running"),
  });

  try {
    await withTraceFixture(
      async (f) => {
        expect(f.endpoint).toBeNull();
        const setup = await Effect.runPromise(f.runtime.setup(TEST_SESSION));
        expect(setup.availability).toHaveProperty("code", "EADDRINUSE");
        expect(JSON.stringify(setup.availability)).toContain(String(owner.port));
        expect(await (await fetch(`http://127.0.0.1:${owner.port}`)).text()).toBe(
          "owner still running"
        );
        expect(await Effect.runPromise(f.store.workerRunning)).toBe(false);
      },
      { port: owner.port! }
    );
  } finally {
    await owner.stop(true);
  }
});
