// Real loopback HTTP, the real trace receiver and store, and an app on the OTel SDK (ADR 0098).
import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT_CONTEXT, SpanKind, defaultTextMapGetter } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { RequestTarget, SEND_BODY_CAP_BYTES, TurnId, type RequestsError } from "@polaris/protocol";
import { Effect } from "effect";
import { TEST_SESSION, withTraceFixture, type TraceFixture } from "../traces/testing.ts";
import { MASK } from "./format/index.ts";
import { closedPort, withSends, withServer } from "./sends.testing.ts";

const SECRET = "s3cr3t-ledger-token-7f2a";

const user = { kind: "user", sessionId: TEST_SESSION } as const;

const agent = { kind: "agent", sessionId: TEST_SESSION, turn: TurnId.make("turn-1") } as const;

const inline = (url: string, extra: { method?: "GET" | "POST"; body?: string } = {}) =>
  RequestTarget.cases.Inline.make({
    request: {
      method: extra.method ?? "GET",
      url,
      headers: [],
      ...(extra.body === undefined ? undefined : { body: extra.body }),
    },
  });

const saved = (file: string, name: string) =>
  RequestTarget.cases.Saved.make({ ref: { file, name } });

/** A Bun.serve app whose server Spans continue the incoming `traceparent`, exported over OTLP. */
const instrumentedApp = (endpoint: string) => {
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": "orders-app" }),
    spanProcessors: [
      new SimpleSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` })),
    ],
  });

  const tracer = provider.getTracer("orders-app");
  const propagator = new W3CTraceContextPropagator();

  const fetch = (request: Request) => {
    const parent = propagator.extract(
      ROOT_CONTEXT,
      Object.fromEntries(request.headers),
      defaultTextMapGetter
    );

    const span = tracer.startSpan("GET /orders", { kind: SpanKind.SERVER }, parent);
    const echoed = request.headers.get("x-echo") ?? "";
    span.end();

    return new Response(`orders for ${echoed}`, { headers: { "x-token-echo": echoed } });
  };

  return { fetch, flush: () => provider.forceFlush(), shutdown: () => provider.shutdown() };
};

const writeLedger = async (root: string, base: string) => {
  await writeFile(join(root, "http-client.env.json"), JSON.stringify({ dev: { base } }));
  await writeFile(
    join(root, "http-client.private.env.json"),
    JSON.stringify({ dev: { token: SECRET } })
  );
  await writeFile(
    join(root, "api.http"),
    [
      "### List orders",
      "GET {{base}}/orders?api={{token}}",
      "Authorization: Bearer {{token}}",
      "X-Echo: {{token}}",
      "",
    ].join("\n")
  );
};

const spansOf = async (f: TraceFixture, traceId: string, count: number) => {
  const deadline = Date.now() + 5000;

  for (;;) {
    const detail = await Effect.runPromise(f.store.get(f.root, traceId));

    if (detail.spans.length >= count || Date.now() > deadline) return detail;
    await Bun.sleep(25);
  }
};

test("the app's server Span joins the Send's root Span in one Trace, with no secret stored", () =>
  withTraceFixture(async (f) => {
    const app = instrumentedApp(f.endpoint!);

    await withServer(app.fetch, async (base) => {
      await writeLedger(f.root, base);

      await withSends(f, async (sends) => {
        const send = await Effect.runPromise(
          sends.send({
            checkout: f.root,
            target: saved("api.http", "List orders"),
            environment: "dev",
            by: user,
          })
        );

        await app.flush();
        expect(send.outcome).toBe("ok");
        expect(send.status).toBe(200);
        const detail = await spansOf(f, send.traceId!, 2);
        const root = detail.spans.find((span) => span.service === "polaris")!;
        const server = detail.spans.find((span) => span.service === "orders-app")!;

        expect(root).toMatchObject({ name: "send", kind: "client", parentId: null });
        expect(root.attributes["http.request.method"]).toBe("GET");
        expect(root.attributes["http.response.status_code"]).toBe("200");
        expect(server.parentId).toBe(root.id);
        expect(server.traceId).toBe(send.traceId!);

        expect(send.responseBody).toBe(`orders for ${MASK}`);
        expect(root.attributes["url.full"]).toBe(`${base}/orders?api=${MASK}`);

        const page = await Effect.runPromise(sends.page(f.root));
        expect(page.sends.map((item) => item.id)).toEqual([send.id]);
        expect(JSON.stringify(page)).not.toContain(SECRET);
        expect(JSON.stringify(detail)).not.toContain(SECRET);
      });
    });

    await app.shutdown();
  }));

test("http-error, refused and timeout are recorded in the Send Log and as error root Spans", () =>
  withTraceFixture(async (f) => {
    const port = await closedPort();
    // The slow route answers only once the test is done, well past the 300 ms deadline.
    const { promise: done, resolve: finish } = Promise.withResolvers<void>();

    const fetch = async (request: Request) => {
      if (new URL(request.url).pathname === "/slow") await done;

      return new Response("boom", { status: 500, statusText: "Internal Server Error" });
    };

    await withServer(fetch, (base) =>
      withSends(
        f,
        async (sends) => {
          const targets = [`${base}/fail`, `http://127.0.0.1:${port}/`, `${base}/slow`];

          for (const url of targets)
            await Effect.runPromise(
              sends.send({ checkout: f.root, target: inline(url), by: user })
            );

          const { sends: logged } = await Effect.runPromise(sends.page(f.root));

          expect(logged.map((send) => [send.outcome, send.status ?? null])).toEqual([
            ["timeout", null],
            ["refused", null],
            ["http-error", 500],
          ]);

          for (const send of logged) {
            const detail = await spansOf(f, send.traceId!, 1);
            expect(detail.spans[0]).toMatchObject({ name: "send", status: "error" });
          }

          finish();
        },
        { timeoutMs: 300 }
      )
    );
  }));

test("a response over 1 MB keeps the first 1 MB and says how large it was", () =>
  withTraceFixture((f) =>
    withServer(
      () => new Response("x".repeat(2 * SEND_BODY_CAP_BYTES + 5)),
      (base) =>
        withSends(f, async (sends) => {
          const send = await Effect.runPromise(
            sends.send({ checkout: f.root, target: inline(`${base}/big`), by: user })
          );

          expect(send.responseTruncated).toBe(true);
          expect(send.responseBytes).toBe(2 * SEND_BODY_CAP_BYTES + 5);
          expect(Buffer.byteLength(send.responseBody!)).toBe(SEND_BODY_CAP_BYTES);
        })
    )
  ));

test("a `< ./file` body is read inside the checkout and refused outside it", () =>
  withTraceFixture(async (f) => {
    await writeFile(join(f.root, "payload.json"), '{"paid":true}');

    await withServer(
      async (request) => new Response(await request.text()),
      (base) =>
        withSends(f, async (sends) => {
          const send = await Effect.runPromise(
            sends.send({
              checkout: f.root,
              target: inline(`${base}/pay`, { method: "POST", body: "< ./payload.json" }),
              by: user,
            })
          );

          expect(send.responseBody).toBe('{"paid":true}');

          const error: RequestsError = await Effect.runPromise(
            Effect.flip(
              sends.send({
                checkout: f.root,
                target: inline(`${base}/pay`, { method: "POST", body: "< ../../etc/passwd" }),
                by: user,
              })
            )
          );

          expect(error.code).toBe("E-INPUT");
          expect(error.message).toContain("../../etc/passwd");
        })
    );
  }));

test("a `.env` or private env file is never sent as a body, and its values are masked anyway", () =>
  withTraceFixture(async (f) => {
    const unused = "dotenv-only-secret-91c4";
    await writeFile(join(f.root, ".env"), `STRIPE_KEY=${unused}\n`);
    await writeFile(join(f.root, "http-client.private.env.json"), "{}");

    await withServer(
      () => new Response(`leaked ${unused}`),
      (base) =>
        withSends(f, async (sends) => {
          for (const file of ["./.env", "./http-client.private.env.json"]) {
            const error: RequestsError = await Effect.runPromise(
              Effect.flip(
                sends.send({
                  checkout: f.root,
                  target: inline(`${base}/x`, { method: "POST", body: `< ${file}` }),
                  by: agent,
                })
              )
            );

            expect(error.message).toContain("holds secrets");
          }

          const send = await Effect.runPromise(
            sends.send({ checkout: f.root, target: inline(`${base}/echo`), by: user })
          );

          expect(send.responseBody).toBe(`leaked ${MASK}`);
        })
    );
  }));

test("a pre-send hook can deny an agent's Send; a user's Send never reaches it", () =>
  withTraceFixture(async (f) => {
    let hits = 0;
    const seen: string[] = [];

    await withServer(
      () => {
        hits += 1;

        return new Response("ok");
      },
      (base) =>
        withSends(f, async (sends) => {
          const run = Effect.scoped(
            Effect.gen(function* () {
              yield* sends.registerPreSend((pending) =>
                Effect.sync(() => {
                  seen.push(`${pending.by.kind} ${pending.method} ${pending.origin}`);

                  return { allow: false, message: "Origin Approval denied" } as const;
                })
              );

              return [
                yield* sends.send({ checkout: f.root, target: inline(`${base}/a`), by: agent }),
                yield* sends.send({ checkout: f.root, target: inline(`${base}/u`), by: user }),
              ];
            })
          );

          const [denied, allowed] = await Effect.runPromise(run);

          expect(denied).toMatchObject({ outcome: "denied", traceId: null });
          expect(allowed?.outcome).toBe("ok");
          expect(hits).toBe(1);
          expect(seen).toEqual([`agent GET ${base}`]);
        })
    );
  }));
