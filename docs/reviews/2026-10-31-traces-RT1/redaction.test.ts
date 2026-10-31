// RT1 repro (ENG-656): realistic secrets reach traces.sqlite unredacted. Expected to FAIL on 08798fa8f.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import {
  postTraces,
  spanFixture,
  traceFixture,
  withTraceFixture,
} from "../../../apps/daemon/src/traces/testing.ts";

const text = (key: string, value: string) => ({ key, value: { stringValue: value } });

const onDisk = async (root: string, secret: string) =>
  (await readFile(join(root, "traces.sqlite"))).includes(Buffer.from(secret));

const ingest = (attributes: ReadonlyArray<unknown>, extra: Record<string, unknown> = {}) => {
  const fixture = traceFixture([{ ...spanFixture(), ...extra }]);
  fixture.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes.push(
    // SAFETY: the fixture's attribute array accepts any OTLP KeyValue shape.
    ...(attributes as typeof fixture.resourceSpans[0]["scopeSpans"][0]["spans"][0]["attributes"])
  );

  return fixture;
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
    const fixture = traceFixture();
    fixture.resourceSpans[0]!.resource.attributes.push({
      key: "process.command_args",
      // SAFETY: OTLP arrayValue is a valid attribute value; the fixture type only lists stringValue.
      value: {
        arrayValue: { values: [{ stringValue: "--token" }, { stringValue: "rt1-argv-token" }] },
      } as unknown as { stringValue: string },
    });
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
  ["exception.stacktrace", "Error: boom\n    at handler (file:///tmp/app/server.mjs:7:34)"],
])("credential-free %s survives redaction", (key, value) =>
  withTraceFixture(async (f) => {
    expect((await postTraces(f.endpoint!, ingest([text(key, value)]))).status).toBe(200);
    const detail = await Effect.runPromise(f.store.get(f.root, "12345678"));
    expect(detail.spans[0]?.attributes[key]).toBe(value);
  })
);
