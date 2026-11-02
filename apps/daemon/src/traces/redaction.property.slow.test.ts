import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import fc from "fast-check";
import { postTraces, spanFixture, traceFixture, withTraceFixture } from "./testing.ts";

const patterns = [
  (secret: string) => `ALTER USER app WITH PASSWORD '${secret}'`,
  (secret: string) => `CREATE USER app IDENTIFIED BY '${secret}'`,
  (secret: string) => `node server.js --password ${secret}`,
  (secret: string) => `AWS_SECRET_ACCESS_KEY=${secret}`,
  (secret: string) => `PREFIX_TOKEN_SUFFIX=${secret}`,
  (secret: string) => `Bearer ${secret}`,
  (secret: string) => `https://user:${secret}@example.test/orders?page=2`,
  (secret: string) => `https://example.test/orders?signature=${secret}&page=2`,
];

test(
  "random credentials in attributes, events, status and log bodies never reach SQLite bytes",
  () =>
    withTraceFixture(async (f) => {
      await fc.assert(
        fc.asyncProperty(
          fc.uuid(),
          fc.integer({ min: 0, max: patterns.length - 1 }),
          async (nonce, pattern) => {
            const secret = `secret${nonce.replaceAll("-", "")}`;
            const value = patterns[pattern]!(secret);
            const attribute = { key: `custom.${nonce}`, value: { stringValue: value } };

            const span = {
              ...spanFixture(),
              name: value,
              attributes: [attribute],
              status: { code: 2, message: value },
              events: [
                {
                  name: value,
                  timeUnixNano: spanFixture().startTimeUnixNano,
                  attributes: [attribute],
                },
              ],
            };

            const fixture = traceFixture();

            const payload = {
              resourceSpans: [
                {
                  ...fixture.resourceSpans[0],
                  resource: { attributes: [attribute] },
                  scopeSpans: [
                    {
                      scope: { name: value, version: "1", attributes: [attribute] },
                      spans: [span],
                    },
                  ],
                },
              ],
            };

            expect((await postTraces(f.endpoint!, payload)).status).toBe(200);
            expect(
              (
                await fetch(`${f.endpoint}/v1/logs`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    resourceLogs: [
                      {
                        scopeLogs: [
                          {
                            logRecords: [
                              {
                                timeUnixNano: span.startTimeUnixNano,
                                body: { stringValue: value },
                                attributes: [attribute],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  }),
                })
              ).status
            ).toBe(200);
            await Effect.runPromise(f.store.flush);
            expect(
              (await readFile(join(f.root, "traces.sqlite"))).includes(Buffer.from(secret))
            ).toBe(false);
          }
        ),
        { numRuns: 60 }
      );
    }),
  30_000
);
