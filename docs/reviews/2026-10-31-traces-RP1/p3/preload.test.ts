import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareAutoInstrumentation } from "../../../../apps/daemon/src/traces/instrumentation/index.ts";

// Real Node children with the real bundled preload; the "Polaris" and "vendor" ends are counters.
const daemonPackage = join(import.meta.dir, "../../../../apps/daemon/package.json");

type Counter = { names: string[]; stop: () => Promise<void>; url: string };

const counter = (): Counter => {
  const names: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname.endsWith("/v1/traces")) {
        const body = (await request.json()) as {
          resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[];
        };

        for (const resource of body.resourceSpans)
          for (const scope of resource.scopeSpans) for (const span of scope.spans) names.push(span.name);
      }

      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
  });

  return { names, stop: () => server.stop(true), url: `http://127.0.0.1:${server.port}` };
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
const sdk = new NodeSDK({ serviceName: "app", instrumentations: [],
  traceExporter: new OTLPTraceExporter({ url: ${JSON.stringify(`${vendorUrl}/v1/traces`)} }) });
sdk.start();
globalThis.appSpan = () => { api.trace.getTracer("app").startSpan("app-manual-span").end(); return sdk.shutdown(); };
`;

const missed = [
  {
    name: "a monorepo package whose SDK sits in its own manifest, launched from the checkout root",
    manifests: {
      "package.json": { name: "monorepo", private: true },
      "apps/web/package.json": { name: "web", dependencies: { "@opentelemetry/sdk-node": "0.300.0" } },
    },
    runIn: "apps/web",
    viaNodeOptions: false,
  },
  {
    name: "an SDK reached through a vendor wrapper package",
    manifests: {
      "package.json": { name: "wrapped", dependencies: { "@honeycombio/opentelemetry-node": "0.9.0" } },
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

    const source = { OTEL_EXPORTER_OTLP_ENDPOINT: `${polaris.url}/otlp/rp1`, NODE_OPTIONS: userOptions };

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

  await prepareAutoInstrumentation(options);
  await rm(join(home, "node-instrumentation"), { recursive: true, force: true });
  const result = await prepareAutoInstrumentation(options);
  const run = await node(["-e", "console.log('started')"], checkout, { ...source, ...result.environment });

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

  const current = await prepareAutoInstrumentation({ checkout, cwd: checkout, settings, source: endpoint, home });
  const register = /--import "([^"]+)"/.exec(current.environment.NODE_OPTIONS ?? "")?.[1];

  expect(register).toBeString();
  // The same assets under an older build's digest, as a terminal opened before an upgrade inherits.
  const older = join(home, "node-instrumentation", "older-build");
  await cp(dirname(new URL(register!).pathname), older, { recursive: true });
  const inherited = `--import ${JSON.stringify(pathToFileURL(join(older, "register.mjs")).href)}`;
  const source = { ...endpoint, NODE_OPTIONS: inherited };

  const result = await prepareAutoInstrumentation({ checkout, cwd: checkout, settings, source, home });
  await writeFile(join(checkout, "fetch.mjs"), `await (await fetch(${JSON.stringify(`${vendor.url}/ping`)})).text();\n`);

  const before = polaris.names.length;
  const run = await node(["fetch.mjs"], checkout, { ...source, ...result.environment });
  await Bun.sleep(1200);

  expect({
    code: run.code,
    spans: polaris.names.slice(before).length,
    warning: run.stderr.includes("already been initialized"),
  }).toEqual({ code: 0, spans: 1, warning: false });
});
