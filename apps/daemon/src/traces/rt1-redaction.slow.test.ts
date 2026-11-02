// RT1 repro (ENG-656): realistic secrets reach traces.sqlite unredacted. Expected to FAIL on 08798fa8f.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OtlpAttribute, OtlpSpan, ExportTraces } from "./otlp.ts";
import { Effect } from "effect";
import { postTraces, spanFixture, withTraceFixture } from "./testing.ts";

const text = (key: string, value: string) => ({ key, value: { stringValue: value } });

const onDisk = async (root: string, secret: string) =>
  (await readFile(join(root, "traces.sqlite"))).includes(Buffer.from(secret));

const ingest = (attributes: ReadonlyArray<OtlpAttribute>, extra: Partial<OtlpSpan> = {}) => {
  const span = spanFixture();

  return {
    resourceSpans: [
      {
        scopeSpans: [
          { spans: [{ ...span, ...extra, attributes: [...span.attributes, ...attributes] }] },
        ],
      },
    ],
  };
};

test.each([
  ["db.statement", "ALTER USER app WITH PASSWORD 'rt1-sql-pw'", "rt1-sql-pw"],
  ["db.query.text", "CREATE USER app IDENTIFIED BY 'rt1-mysql-pw'", "rt1-mysql-pw"],
  ["process.command_line", "node server.js --password rt1-cli-pw", "rt1-cli-pw"],
  ["log.message", "AWS_SECRET_ACCESS_KEY=rt1AwsSecretValue", "rt1AwsSecretValue"],
  ["message", "token sk-ant-api03-rt1AnthropicKey", "rt1AnthropicKey"],
  ["http.request.header.x-auth", "rt1-header-auth", "rt1-header-auth"],
  ["webhook.signature", "rt1-signature-value", "rt1-signature-value"],
])("attribute %s with %p is not stored in clear", (key, value, secret) =>
  withTraceFixture(async (f) => {
    expect((await postTraces(f.endpoint!, ingest([text(key, value)]))).status).toBe(200);
    await Effect.runPromise(f.store.flush);
    expect(await onDisk(f.root, secret)).toBe(false);
  })
);

test("process.command_args array (default Node resource detector) is not stored in clear", () =>
  withTraceFixture(async (f) => {
    const fixture: typeof ExportTraces.Type = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              {
                key: "process.command_args",
                value: {
                  arrayValue: {
                    values: [{ stringValue: "--token" }, { stringValue: "rt1-argv-token" }],
                  },
                },
              },
            ],
          },
          scopeSpans: [{ spans: [spanFixture()] }],
        },
      ],
    };

    expect((await postTraces(f.endpoint!, fixture)).status).toBe(200);
    await Effect.runPromise(f.store.flush);
    expect(await onDisk(f.root, "rt1-argv-token")).toBe(false);
  }));

test("Span status message with a SQL password is not stored in clear", () =>
  withTraceFixture(async (f) => {
    const fixture = ingest([], {
      status: { code: 2, message: "ALTER USER app WITH PASSWORD 'rt1-status-pw' failed" },
    });

    expect((await postTraces(f.endpoint!, fixture)).status).toBe(200);
    await Effect.runPromise(f.store.flush);
    expect(await onDisk(f.root, "rt1-status-pw")).toBe(false);
  }));

test("bytesValue attributes are not exempt from redaction", () =>
  withTraceFixture(async (f) => {
    const encoded = Buffer.from("password=rt1-bytes-pw").toString("base64");
    const fixture = ingest([{ key: "payload", value: { bytesValue: encoded } }]);
    expect((await postTraces(f.endpoint!, fixture)).status).toBe(200);
    await Effect.runPromise(f.store.flush);
    expect(await onDisk(f.root, encoded)).toBe(false);
  }));

// Over-redaction (reported by P7, widened here): any URL makes the whole value "[redacted]".
test.each([
  ["url.full", "https://example.com/orders?page=2"],
  ["http.url", "http://127.0.0.1:3000/api/users"],
  ["url.full", "https://example.test/password=docs?page=2"],
  ["exception.stacktrace", "at file:///tmp/auth=notes/server.mjs:7:34"],
  ["exception.stacktrace", "Error: boom\n    at handler (file:///tmp/app/server.mjs:7:34)"],
])("credential-free %s survives redaction", (key, value) =>
  withTraceFixture(async (f) => {
    expect((await postTraces(f.endpoint!, ingest([text(key, value)]))).status).toBe(200);
    const detail = await Effect.runPromise(f.store.get(f.root, "12345678"));
    expect(detail.spans[0]?.attributes[key]).toBe(value);
  })
);

test.each([
  "sk-proj-veryPrivateVendorCredential",
  "ghp_veryPrivateGithubCredential",
  "gho_veryPrivateGithubCredential",
  "xoxb-123456789-privateSlackCredential",
  "AKIAABCDEFGHIJKLMNOP",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.privateSignature",
])("bare vendor credential %s never reaches SQLite", (secret) =>
  withTraceFixture(async (f) => {
    expect((await postTraces(f.endpoint!, ingest([text("custom.value", secret)]))).status).toBe(
      200
    );
    await Effect.runPromise(f.store.flush);
    expect(await onDisk(f.root, secret)).toBe(false);
  })
);

test.each(["auth", "signature", "jwt", "session_id", "passphrase", "pwd"])(
  "sensitive key %s cannot leak its value",
  (key) =>
    withTraceFixture(async (f) => {
      const secret = `hidden-${crypto.randomUUID()}`;
      expect((await postTraces(f.endpoint!, ingest([text(key, secret)]))).status).toBe(200);
      await Effect.runPromise(f.store.flush);
      expect(await onDisk(f.root, secret)).toBe(false);
    })
);

test("credential-bearing URLs retain routing information in attributes, names and ESM frames", () =>
  withTraceFixture(async (f) => {
    const url =
      "https://alice:private-url@example.test/orders?token=private-query&page=2&code=private-code";

    const clean = "https://[redacted]@example.test/orders?token=[redacted]&page=2&code=[redacted]";
    expect(
      (
        await postTraces(
          f.endpoint!,
          ingest(
            [
              text("url.full", url),
              text("http.url", url),
              text(
                "exception.stacktrace",
                `at handler (file:///tmp/server.mjs?token=private-frame:7:34)`
              ),
            ],
            { name: `GET ${url}` }
          )
        )
      ).status
    ).toBe(200);
    const detail = await Effect.runPromise(f.store.get(f.root, "12345678"));
    expect(detail.spans[0]?.name).toBe(`GET ${clean}`);
    expect(detail.spans[0]?.attributes["url.full"]).toBe(clean);
    expect(detail.spans[0]?.attributes["http.url"]).toBe(clean);
    expect(JSON.stringify(detail)).not.toContain("private-");
  }));
