import { pathToFileURL } from "node:url";
import { shortTemp } from "../../platform/testing.ts";
import { beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { autoInstrumentationEnvironment, prepareAutoInstrumentation } from "./index.ts";
import { buildInstrumentationAssets, instrumentationPlugin } from "./build.ts";
import { materializeInstrumentation } from "./assets.ts";
import { appendNodeImport, instrumentationImport } from "../nodeOptions.ts";
import { withTraceFixture } from "../testing.ts";

const settings = { enabled: true, autoInstrument: "node", autoInstrumentOverride: false } as const;

const source = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4319/otlp/test" };

const temp = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(shortTemp("p3-instrumentation-"));

  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("off, Deno and Bun select their requested runtime policy", () =>
  temp(async (root) => {
    const base = {
      checkout: root,
      cwd: root,
      source,
      settings,
      registerPath: "/unused/register.mjs",
    };

    expect(
      await autoInstrumentationEnvironment({
        ...base,
        settings: { ...settings, autoInstrument: "off" },
      })
    ).toEqual({});
    expect(
      await autoInstrumentationEnvironment({ ...base, settings: { ...settings, enabled: false } })
    ).toHaveProperty("NODE_OPTIONS");
    expect(await autoInstrumentationEnvironment({ ...base, runtime: "bun" })).toEqual({});
    expect(
      await autoInstrumentationEnvironment({
        ...base,
        settings: { ...settings, autoInstrument: "deno" },
      })
    ).toEqual({ OTEL_DENO: "true" });
    expect((await prepareAutoInstrumentation({ ...base, source: {} })).skipReason).toContain(
      "unavailable"
    );
  }));

for (const dependency of [
  "@opentelemetry/sdk-node",
  "@opentelemetry/sdk-trace-base",
  "@opentelemetry/sdk-trace-node",
  "@opentelemetry/sdk-trace",
]) {
  test(`skip ${dependency} in a parent manifest unless explicitly overridden`, () =>
    temp(async (root) => {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ devDependencies: { [dependency]: "1.0.0" } })
      );
      const cwd = join(root, "packages/app");
      await mkdir(cwd, { recursive: true });
      await writeFile(join(cwd, "package.json"), '{"name":"nested-app"}');

      const base = {
        checkout: root,
        cwd,
        source: { ...source, NODE_OPTIONS: "--no-warnings" },
        settings,
        registerPath: "/tmp/space here/register.mjs",
      };

      const result = await prepareAutoInstrumentation(base);
      expect(result.environment).toEqual({});
      expect(result.skipReason).toContain(dependency);

      const env = await autoInstrumentationEnvironment({
        ...base,
        settings: { ...settings, autoInstrumentOverride: true },
      });

      expect(env.NODE_OPTIONS).toBe(
        appendNodeImport("--no-warnings", instrumentationImport("/tmp/space here/register.mjs"))
      );
      expect(env.POLARIS_OTEL_SERVICE_NAME).toBe("nested-app");
    }));
}

let assets: Record<string, string>;

beforeAll(async () => {
  assets = await buildInstrumentationAssets();
});

test(
  "compiled executable materializes the bundled register without checkout dependencies",
  () =>
    temp(async (root) => {
      const entry = join(root, "probe.ts");
      await writeFile(
        entry,
        `import {bundledRegisterPath} from ${JSON.stringify(join(import.meta.dir, "assets.ts"))}; console.log(await bundledRegisterPath());`
      );
      const binary = join(root, "probe");

      const plugin = await instrumentationPlugin();

      const compiled = await Bun.build({
        entrypoints: [entry],
        compile: { outfile: binary },
        plugins: [plugin],
      });

      plugin.assertEmbedded();
      expect(compiled.logs.map((log) => log.message)).toEqual([]);
      expect(compiled.success).toBe(true);

      const child = Bun.spawn([binary], {
        cwd: root,
        env: { POLARIS_HOME: join(root, "home"), PATH: process.env.PATH! },
        stdout: "pipe",
        stderr: "pipe",
      });

      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      const registerPath = stdout.trim();

      const node = Bun.spawn(
        ["node", "--import", pathToFileURL(registerPath).href, "-e", "console.log('standalone')"],
        {
          cwd: root,
          env: { PATH: process.env.PATH!, POLARIS_OTEL_ENDPOINT: "http://127.0.0.1:1" },
          stdout: "pipe",
          stderr: "pipe",
        }
      );

      expect(await node.exited).toBe(0);
      expect((await new Response(node.stdout).text()).trim()).toBe("standalone");
      expect(await new Response(node.stderr).text()).toBe("");
    }),
  20000
);

test(
  "bundled Node HTTP and fetch instrumentation keeps the server and its outgoing fetch in one parented trace",
  () =>
    withTraceFixture(async (f) => {
      const registerPath = await materializeInstrumentation(assets, f.root);
      await writeFile(join(f.root, "package.json"), '{"name":"real-node-app"}');

      const upstream = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("upstream-ok"),
      });

      try {
        const script = join(f.root, "app.mjs");
        await writeFile(
          script,
          `import http from 'node:http';
        const server = http.createServer(async (_req,res) => {
          res.end(await (await fetch('http://127.0.0.1:${upstream.port}/data')).text());
        });
        server.listen(0,'127.0.0.1',async () => {
          console.log(await (await fetch('http://127.0.0.1:'+server.address().port+'/hello')).text());
          server.close();
        });`
        );

        const env = await autoInstrumentationEnvironment({
          checkout: f.root,
          cwd: f.root,
          settings,
          source: { OTEL_EXPORTER_OTLP_ENDPOINT: f.endpoint!, NODE_OPTIONS: "--no-warnings" },
          registerPath,
        });

        const child = Bun.spawn(["node", script], {
          cwd: f.root,
          env: { PATH: process.env.PATH!, ...env },
          stdout: "pipe",
          stderr: "pipe",
        });

        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);

        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        expect(stdout.trim()).toBe("upstream-ok");
        const page = await Effect.runPromise(f.store.list(f.root));
        expect(page.total).toBeGreaterThan(0);

        const details = await Promise.all(
          page.traces.map((trace) => Effect.runPromise(f.store.get(f.root, trace.id)))
        );

        const spans = details.flatMap((detail) => detail.spans);
        expect(spans.some((span) => span.kind === "server")).toBe(true);
        expect(
          spans.some((span) => span.scope.name === "@opentelemetry/instrumentation-undici")
        ).toBe(true);
        expect(spans.every((span) => span.resource["service.name"] === "real-node-app")).toBe(true);
        const serverSpan = spans.find((span) => span.kind === "server")!;

        const childSpan = spans.find(
          (span) =>
            span.scope.name === "@opentelemetry/instrumentation-undici" &&
            span.parentId === serverSpan.id
        );

        expect(childSpan?.traceId).toBe(serverSpan.traceId);
        expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
      } finally {
        await upstream.stop(true);
      }
    }),
  20000
);

test(
  "endpoint failure does not crash or hold a finite Node command open",
  () =>
    temp(async (root) => {
      const registerPath = await materializeInstrumentation(assets, root);

      const env = await autoInstrumentationEnvironment({
        checkout: root,
        cwd: root,
        settings,
        source: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1" },
        registerPath,
      });

      const child = Bun.spawn(
        ["node", "-e", "fetch('http://127.0.0.1:1').catch(()=>console.log('app survived'))"],
        { env: { PATH: process.env.PATH!, ...env }, stdout: "pipe", stderr: "pipe" }
      );

      const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect(code).toBe(0);
      expect(stdout.trim()).toBe("app survived");
    }),
  10000
);

test("unreadable manifest bounds fail closed instead of assuming no SDK", () =>
  temp(async (root) => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        dependencies: { "@opentelemetry/sdk-node": "0.300.0" },
        padding: "x".repeat(65536),
      })
    );

    const result = await prepareAutoInstrumentation({
      checkout: root,
      cwd: root,
      source,
      settings,
      registerPath: "/unused/register.mjs",
    });

    expect(result.environment).toEqual({});
    expect(result.skipReason).toContain("could not be checked");
  }));

test("a known SDK wrapper is skipped to preserve Vercel's second exporter", () =>
  temp(async (root) => {
    await writeFile(join(root, "package.json"), '{"dependencies":{"@vercel/otel":"2.1.1"}}');
    expect(
      (
        await prepareAutoInstrumentation({
          checkout: root,
          cwd: root,
          source,
          settings,
          registerPath: "/unused/register.mjs",
        })
      ).skipReason
    ).toContain("@vercel/otel");
  }));
