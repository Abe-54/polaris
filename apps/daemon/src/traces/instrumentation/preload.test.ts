import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Schema } from "effect";
import { bundledRegisterPath } from "./assets.ts";
import { prepareAutoInstrumentation } from "./index.ts";

// Real Node children with the real bundled preload; the "Polaris" and "vendor" ends are counters.
const daemonPackage = join(import.meta.dir, "../../../package.json");

const ExportedSpan = Schema.Struct({
  name: Schema.String,
  traceId: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.Number),
});

type Counter = {
  spans: Array<typeof ExportedSpan.Type>;
  logs: string[];
  names: string[];
  stop: () => Promise<void>;
  url: string;
};

const counter = (): Counter => {
  const names: string[] = [];
  const logs: string[] = [];
  const spans: Array<typeof ExportedSpan.Type> = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname.endsWith("/v1/traces")) {
        const body = Schema.decodeUnknownSync(
          Schema.Struct({
            resourceSpans: Schema.Array(
              Schema.Struct({
                scopeSpans: Schema.Array(
                  Schema.Struct({
                    spans: Schema.Array(ExportedSpan),
                  })
                ),
              })
            ),
          })
        )(await request.json());

        for (const resource of body.resourceSpans)
          for (const scope of resource.scopeSpans)
            for (const span of scope.spans) {
              names.push(span.name);
              spans.push(span);
            }
      }

      if (new URL(request.url).pathname.endsWith("/v1/logs")) {
        const body = Schema.decodeUnknownSync(
          Schema.Struct({
            resourceLogs: Schema.Array(
              Schema.Struct({
                scopeLogs: Schema.Array(
                  Schema.Struct({
                    logRecords: Schema.Array(
                      Schema.Struct({ body: Schema.Struct({ stringValue: Schema.String }) })
                    ),
                  })
                ),
              })
            ),
          })
        )(await request.json());

        logs.push(
          ...body.resourceLogs.flatMap((resource) =>
            resource.scopeLogs.flatMap((scope) =>
              scope.logRecords.map((log) => log.body.stringValue)
            )
          )
        );
      }

      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
  });

  return {
    spans,
    logs,
    names,
    stop: () => server.stop(true),
    url: `http://127.0.0.1:${server.port}`,
  };
};

let polaris: Counter;

let vendor: Counter;

let scratch: string;

beforeAll(async () => {
  polaris = counter();
  vendor = counter();
  scratch = await mkdtemp("/tmp/rp1-p3-");
});

afterAll(async () => {
  await polaris.stop();
  await vendor.stop();
  await rm(scratch, { recursive: true, force: true });
});

const settings = { enabled: true, autoInstrument: "node", autoInstrumentOverride: false } as const;

const node = async (args: string[], cwd: string, env: Record<string, string | undefined>) => {
  const child = Bun.spawn(["node", ...args], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);

  return { code, stderr };
};

// The app's own SDK, started the way the OTel docs show, exporting to its vendor.
const appSdk = (vendorUrl: string) => `
const req = require("node:module").createRequire(${JSON.stringify(daemonPackage)});
const { NodeSDK } = req("@opentelemetry/sdk-node");
const { OTLPTraceExporter } = req("@opentelemetry/exporter-trace-otlp-http");
const api = req("@opentelemetry/api");
const { BatchLogRecordProcessor } = req("@opentelemetry/sdk-logs");
const { OTLPLogExporter } = req("@opentelemetry/exporter-logs-otlp-http");
const sdk = new NodeSDK({ serviceName: "app", instrumentations: [],
  logRecordProcessors: [new BatchLogRecordProcessor({exporter: new OTLPLogExporter({url: ${JSON.stringify(`${vendorUrl}/v1/logs`)}})})],
  traceExporter: new OTLPTraceExporter({ url: ${JSON.stringify(`${vendorUrl}/v1/traces`)} }) });
sdk.start();
globalThis.appSpan = () => { api.trace.getTracer("app").startSpan("app-manual-span").end(); api.logs.getLogger("app").emit({body:"app-manual-log"}); return sdk.shutdown(); };
`;

const missed = [
  {
    name: "a monorepo package whose SDK sits in its own manifest, launched from the checkout root",
    manifests: {
      "package.json": { name: "monorepo", private: true },
      "apps/web/package.json": {
        name: "web",
        dependencies: { "@opentelemetry/sdk-node": "0.300.0" },
      },
    },
    runIn: "apps/web",
    viaNodeOptions: false,
  },
  {
    name: "an SDK reached through a vendor wrapper package",
    manifests: {
      "package.json": {
        name: "wrapped",
        dependencies: { "@honeycombio/opentelemetry-node": "0.9.0" },
      },
    },
    runIn: ".",
    viaNodeOptions: false,
  },
  {
    name: "an SDK preloaded through the user's own NODE_OPTIONS",
    manifests: { "package.json": { name: "zero-code" } },
    runIn: ".",
    viaNodeOptions: true,
  },
];

for (const scenario of missed)
  test(`finding P3-1: ${scenario.name} keeps its own spans`, async () => {
    const checkout = await mkdtemp(join(scratch, "app-"));

    for (const [file, manifest] of Object.entries(scenario.manifests)) {
      await mkdir(dirname(join(checkout, file)), { recursive: true });
      await writeFile(join(checkout, file), JSON.stringify(manifest));
    }

    const cwd = join(checkout, scenario.runIn);
    await writeFile(join(cwd, "sdk.cjs"), appSdk(vendor.url));
    await writeFile(
      join(cwd, "app.cjs"),
      `${scenario.viaNodeOptions ? "" : 'require("./sdk.cjs");\n'}globalThis.appSpan();\n`
    );

    const userOptions = scenario.viaNodeOptions
      ? `--import ${JSON.stringify(pathToFileURL(join(cwd, "sdk.cjs")).href)}`
      : undefined;

    const source = {
      OTEL_EXPORTER_OTLP_ENDPOINT: `${polaris.url}/otlp/rp1`,
      NODE_OPTIONS: userOptions,
    };

    const result = await prepareAutoInstrumentation({
      checkout,
      cwd: checkout,
      settings,
      source,
      home: join(scratch, "home"),
    });

    const before = vendor.names.length;
    const run = await node(["app.cjs"], cwd, { ...source, ...result.environment });
    await Bun.sleep(1200);

    expect({ code: run.code, vendor: vendor.names.slice(before) }).toEqual({
      code: 0,
      vendor: ["app-manual-span"],
    });
  });

test("finding P3-2: a preload deleted while the Daemon runs never stops node from starting", async () => {
  const home = join(scratch, "deleted-home");
  const checkout = await mkdtemp(join(scratch, "plain-"));
  await writeFile(join(checkout, "package.json"), JSON.stringify({ name: "plain" }));
  const source = { OTEL_EXPORTER_OTLP_ENDPOINT: `${polaris.url}/otlp/rp1` };
  const options = { checkout, cwd: checkout, settings, source, home };

  const original = await prepareAutoInstrumentation(options);
  await rm(join(home, "node-instrumentation"), { recursive: true, force: true });
  const inherited = await node(["-e", "0"], checkout, original.environment);
  expect(inherited).toEqual({ code: 0, stderr: "" });
  const result = await prepareAutoInstrumentation(options);
  expect(await Bun.file(await bundledRegisterPath(home)).exists()).toBe(true);

  const run = await node(["-e", "console.log('started')"], checkout, {
    ...source,
    ...result.environment,
  });

  expect({ code: run.code, missing: run.stderr.includes("ERR_MODULE_NOT_FOUND") }).toEqual({
    code: 0,
    missing: false,
  });
});

test("finding P3-3: an inherited preload from another Daemon build exports each span once", async () => {
  const home = join(scratch, "upgrade-home");
  const checkout = await mkdtemp(join(scratch, "upgrade-"));
  await writeFile(join(checkout, "package.json"), JSON.stringify({ name: "upgraded" }));
  const endpoint = { OTEL_EXPORTER_OTLP_ENDPOINT: `${polaris.url}/otlp/rp1` };

  await prepareAutoInstrumentation({ checkout, cwd: checkout, settings, source: endpoint, home });
  const register = pathToFileURL(await bundledRegisterPath(home)).href;

  expect(register).toBeString();
  // The same assets under an older build's digest, as a terminal opened before an upgrade inherits.
  const older = join(home, "node-instrumentation", "older-build");
  await cp(dirname(new URL(register).pathname), older, { recursive: true });
  const inherited = `--import ${JSON.stringify(pathToFileURL(join(older, "register.mjs")).href)}`;
  const source = { ...endpoint, NODE_OPTIONS: inherited };

  const result = await prepareAutoInstrumentation({
    checkout,
    cwd: checkout,
    settings,
    source,
    home,
  });

  await writeFile(
    join(checkout, "fetch.mjs"),
    `await (await fetch(${JSON.stringify(`${vendor.url}/ping`)})).text();\n`
  );

  const before = polaris.names.length;
  const run = await node(["fetch.mjs"], checkout, { ...source, ...result.environment });
  await Bun.sleep(1200);

  expect({
    code: run.code,
    spans: polaris.names.slice(before).length,
    warning: run.stderr.includes("already been initialized"),
  }).toEqual({ code: 0, spans: 1, warning: false });
});

test("an unrecognized SDK started after Polaris retains its global trace and log exporters", async () => {
  const checkout = await mkdtemp(join(scratch, "late-sdk-"));
  await writeFile(join(checkout, "package.json"), '{"name":"late-sdk"}');

  const env = await prepareAutoInstrumentation({
    checkout,
    cwd: checkout,
    settings,
    source: { OTEL_EXPORTER_OTLP_ENDPOINT: polaris.url },
    home: join(scratch, "home"),
  });

  await writeFile(join(checkout, "app.cjs"), `${appSdk(vendor.url)}globalThis.appSpan();`);
  const before = vendor.names.length;
  const beforeLogs = vendor.logs.length;
  const run = await node(["app.cjs"], checkout, env.environment);
  expect(run).toEqual({ code: 0, stderr: "" });
  expect(vendor.names.slice(before)).toEqual(["app-manual-span"]);
  expect(vendor.logs.slice(beforeLogs)).toEqual(["app-manual-log"]);
});

test("two direct register imports and two SDK copies still install just one instrumentation", async () => {
  const home = join(scratch, "guard-home");
  const register = await bundledRegisterPath(home);
  const older = join(home, "node-instrumentation", "manual-copy");
  await cp(dirname(register), older, { recursive: true });
  const checkout = await mkdtemp(join(scratch, "guard-app-"));
  await writeFile(
    join(checkout, "app.mjs"),
    `await import(${JSON.stringify(pathToFileURL(join(older, "sdk.cjs")).href)}); await (await fetch(${JSON.stringify(vendor.url)})).text();`
  );
  const before = polaris.names.length;

  const run = await node(
    ["--import", register, "--import", join(older, "register.mjs"), "app.mjs"],
    checkout,
    { POLARIS_OTEL_ENDPOINT: polaris.url }
  );

  expect(run).toEqual({ code: 0, stderr: "" });
  expect(polaris.names.slice(before)).toHaveLength(1);
});

test("no endpoint loads neither the ESM hook nor the SDK", async () => {
  const home = join(scratch, "no-endpoint-home");
  const register = await bundledRegisterPath(home);
  await writeFile(join(dirname(register), "hook.mjs"), "throw Error('hook loaded');");
  await writeFile(join(dirname(register), "sdk.cjs"), "process.exit(43);");
  const run = await node(["--import", register, "-e", "0"], scratch, {});
  expect(run).toEqual({ code: 0, stderr: "" });
});

for (const dependency of [
  "@opentelemetry/sdk-node",
  "@opentelemetry/sdk-trace-base",
  "@opentelemetry/sdk-trace",
  "@vercel/otel",
  "@honeycombio/opentelemetry-node",
  "@sentry/node",
  "@azure/monitor-opentelemetry",
  "dd-trace",
]) {
  test(`child entry package with ${dependency} owns automatic instrumentation`, async () => {
    const checkout = await mkdtemp(join(scratch, "entry-owner-"));
    const entry = join(checkout, "app");
    await mkdir(entry);
    await writeFile(
      join(entry, "package.json"),
      JSON.stringify({ dependencies: { [dependency]: "^8.0.0" } })
    );

    const result = await prepareAutoInstrumentation({
      checkout,
      cwd: checkout,
      settings,
      source: { OTEL_EXPORTER_OTLP_ENDPOINT: polaris.url },
      home: join(scratch, "home"),
    });

    await writeFile(
      join(entry, "fetch.mjs"),
      `await (await fetch(${JSON.stringify(vendor.url)})).text();`
    );
    const before = polaris.names.length;
    const run = await node([join(entry, "fetch.mjs")], checkout, result.environment);
    expect(run).toEqual({ code: 0, stderr: "" });
    expect(polaris.names.slice(before)).toEqual([]);
  });
}

test("a late app SDK exports its manual request span to its vendor under the Polaris server span", async () => {
  const checkout = await mkdtemp(join(scratch, "nested-sdk-"));
  await writeFile(join(checkout, "package.json"), '{"name":"nested-sdk"}');

  const result = await prepareAutoInstrumentation({
    checkout,
    cwd: checkout,
    settings,
    source: { OTEL_EXPORTER_OTLP_ENDPOINT: polaris.url },
    home: join(scratch, "home"),
  });

  await writeFile(
    join(checkout, "app.cjs"),
    `${appSdk(vendor.url)}
    const http = require('node:http');
    const server = http.createServer(async (_req, res) => {
      await Promise.resolve();
      await globalThis.appSpan();
      res.end('ok');
    });
    server.listen(0, '127.0.0.1', async () => {
      await (await fetch('http://127.0.0.1:' + server.address().port)).text();
      server.close();
    });`
  );
  const vendorBefore = vendor.spans.length;
  const polarisBefore = polaris.spans.length;
  const run = await node(["app.cjs"], checkout, result.environment);
  expect(run).toEqual({ code: 0, stderr: "" });
  const manual = vendor.spans.slice(vendorBefore).find((span) => span.name === "app-manual-span")!;
  const request = polaris.spans.slice(polarisBefore).find((span) => span.kind === 2)!;
  expect(manual.traceId).toBe(request.traceId);
  expect(manual.parentSpanId).toBe(request.spanId);
  expect(polaris.spans.slice(polarisBefore).some((span) => span.name === "app-manual-span")).toBe(
    false
  );
});

test("a configured batch delay exports while the Node application stays running", async () => {
  const checkout = await mkdtemp(join(scratch, "scheduled-export-"));

  const result = await prepareAutoInstrumentation({
    checkout,
    cwd: checkout,
    settings,
    source: { OTEL_EXPORTER_OTLP_ENDPOINT: polaris.url },
    home: join(scratch, "home"),
  });

  await writeFile(
    join(checkout, "app.mjs"),
    `
    await (await fetch(${JSON.stringify(vendor.url)})).text();
    console.log('ready');
    setInterval(() => {}, 10000);`
  );
  const before = polaris.names.length;

  const child = Bun.spawn(["node", "app.mjs"], {
    cwd: checkout,
    env: { PATH: process.env.PATH, ...result.environment, OTEL_BSP_SCHEDULE_DELAY: "25" },
    stdout: "pipe",
    stderr: "pipe",
  });

  const reader = child.stdout.getReader();

  try {
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");

    for (let attempt = 0; attempt < 100 && polaris.names.length === before; attempt++)
      await Bun.sleep(20);
    expect(polaris.names.slice(before)).toHaveLength(1);
  } finally {
    reader.releaseLock();
    child.kill();
    await child.exited;
  }
});
