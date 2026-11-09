/**
 * The invoices app the Requests end-to-end script sends to: Bun.serve over SQLite, traced with
 * OTel (W3C propagation, OTLP/HTTP to the Workspace's endpoint), plus `http/invoices.http`.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { REPO_ROOT } from "./electron.ts";

export const SAMPLE_TOKEN = "tok_live_9f8e7d6c5b4a";

const SERVER = String.raw`
import { context, propagation, trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { TracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const traced = endpoint !== undefined && endpoint !== "";
const file = realpathSync(".") + "/app.db";
const db = new Database(file, { create: true });

if (traced) {
  const exporter = new OTLPTraceExporter({ url: endpoint + "/v1/traces" });
  const exportSpans = exporter.export.bind(exporter);
  exporter.export = (spans, done) => exportSpans(spans, (result) => {
    if (result.code !== 0) console.error("invoices: export failed: " + result.error);
    else console.error("invoices: exported " + spans.length + " span(s) in " + spans[0]?.spanContext().traceId);
    done(result);
  });
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ "service.name": "invoices" }),
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
}

const tracer = trace.getTracer("invoices");

const query = (op, table, sql, args, run) =>
  tracer.startActiveSpan(op + " " + table, { kind: SpanKind.CLIENT, attributes: {
    "db.system.name": "sqlite", "db.namespace": file, "db.collection.name": table,
    "db.operation.name": op, "db.query.text": sql,
  } }, (span) => {
    try { return run(db.query(sql), args); }
    catch (error) { span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) }); throw error; }
    finally { span.end(); }
  });

const json = (body, status = 200) => Response.json(body, { status });

const handle = async (request, url) => {
  const auth = request.headers.get("authorization");
  if (auth !== "Bearer " + process.env.TOKEN) return json({ error: "unauthorized", saw: auth }, 401);
  if (request.method === "GET" && url.pathname === "/invoices") {
    const customer = query("SELECT", "customers", "SELECT id, name FROM customers WHERE id = ?", [Number(url.searchParams.get("customer") ?? 1)], (q, a) => q.get(...a));
    const invoices = query("SELECT", "invoices", "SELECT id, amount, status FROM invoices WHERE customer_id = ?", [customer?.id ?? 0], (q, a) => q.all(...a));
    return json({ customer, invoices, auth });
  }
  if (request.method === "POST" && url.pathname === "/invoices") {
    const body = await request.json();
    const customer = query("SELECT", "customers", "SELECT id FROM customers WHERE id = ?", [body.customer], (q, a) => q.get(...a));
    if (customer === null) return json({ error: "no such customer" }, 404);
    const row = query("INSERT", "invoices", "INSERT INTO invoices (customer_id, amount, status) VALUES (?, ?, 'open') RETURNING id, amount, status", [customer.id, body.amount], (q, a) => q.get(...a));
    return json({ created: row, auth }, 201);
  }
  return json({ error: "not found" }, 404);
};

Bun.serve({
  port: Number(process.env.PORT),
  hostname: "127.0.0.1",
  fetch: (request) => {
    const url = new URL(request.url);
    const parent = propagation.extract(context.active(), Object.fromEntries(request.headers));
    return context.with(parent, () =>
      tracer.startActiveSpan(request.method + " " + url.pathname, { kind: SpanKind.SERVER, attributes: {
        "http.request.method": request.method, "url.path": url.pathname,
      } }, async (span) => {
        try {
          const response = await handle(request, url);
          span.setAttribute("http.response.status_code", response.status);
          return response;
        } finally { span.end(); }
      }));
  },
});
console.log("listening " + process.env.PORT + (traced ? " traced" : " untraced"));
`;

const SCHEMA = `
CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE invoices (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), amount INTEGER NOT NULL, status TEXT NOT NULL);
INSERT INTO customers (id, name) VALUES (1, 'Acme'), (2, 'Globex');
INSERT INTO invoices (customer_id, amount, status) VALUES (1, 1200, 'open'), (1, 300, 'paid'), (2, 990, 'open');
`;

const HTTP = `### List invoices
GET {{base}}/invoices?customer=1
Accept: application/json
Authorization: Bearer {{$dotenv TOKEN}}

### Create invoice
POST {{base}}/invoices
Content-Type: application/json
Authorization: Bearer {{$dotenv TOKEN}}

{ "customer": 1, "amount": 4200 }
`;

export interface SamplePorts {
  readonly traced: number;
  readonly untraced: number;
}

/** A git checkout holding the app, its database and request files. */
export const writeSampleApp = (dir: string, ports: SamplePorts) => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "http"), { recursive: true });
  writeFileSync(join(dir, "server.ts"), SERVER);
  writeFileSync(join(dir, "schema.sql"), SCHEMA);
  writeFileSync(join(dir, ".env"), `DATABASE_URL=file:./app.db\nTOKEN=${SAMPLE_TOKEN}\n`);
  writeFileSync(join(dir, ".gitignore"), "node_modules\napp.db\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "invoices", private: true }));
  writeFileSync(join(dir, "http/invoices.http"), HTTP);
  writeFileSync(
    join(dir, "http/http-client.env.json"),
    JSON.stringify(
      {
        dev: { base: `http://127.0.0.1:${ports.traced}` },
        untraced: { base: `http://127.0.0.1:${ports.untraced}` },
        remote: { base: "https://example.com" },
      },
      null,
      2
    )
  );
  // The app's OTel packages come from the Daemon's dependencies.
  symlinkSync(join(REPO_ROOT, "apps/daemon/node_modules"), join(dir, "node_modules"));
  const sql = spawnSync("sqlite3", [join(dir, "app.db")], { input: SCHEMA });

  if (sql.status !== 0) throw new Error(`sqlite3 failed: ${sql.stderr.toString()}`);

  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["commit", "-qm", "invoices app"],
  ])
    spawnSync("git", args, { cwd: dir, stdio: "ignore" });
};

/** Starts the app on `port`, exporting to `endpoint` when it is given. */
export const startSampleApp = async (dir: string, port: number, endpoint: string | null) => {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PORT: String(port),
    TOKEN: SAMPLE_TOKEN,
  };

  if (endpoint !== null) env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;

  const child: ChildProcess = spawn("bun", ["server.ts"], {
    cwd: dir,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });

  for (let i = 0; i < 100; i++) {
    const up = await fetch(`http://127.0.0.1:${port}/`).then(
      () => true,
      () => false
    );

    if (up) break;
    await sleep(100);
  }

  return {
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
};
