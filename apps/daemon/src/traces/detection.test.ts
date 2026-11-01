import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectorFromEnvironment, detectExporters, publicCollector } from "./detection.ts";

const fixture = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp("/tmp/p1-detect-");

  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("exported trace endpoint takes precedence over general; checkout endpoints are suggestions", () =>
  fixture(async (root) => {
    await writeFile(
      join(root, ".env"),
      'OTEL_EXPORTER_OTLP_ENDPOINT="http://from-file.test/base"\n'
    );
    await writeFile(
      join(root, ".env.local"),
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://local.test/v1/traces\n"
    );

    const source = {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://exported.test/base",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://specific.test/custom",
    };

    expect((await detectExporters(root, source)).collector?.traces).toBe(
      "http://specific.test/custom"
    );
    expect(
      (
        await detectExporters(root, {
          OTEL_EXPORTER_OTLP_ENDPOINT: source.OTEL_EXPORTER_OTLP_ENDPOINT,
        })
      ).collector?.traces
    ).toBe("http://exported.test/base/v1/traces");
    const detected = await detectExporters(root, {});
    expect(detected.collector).toBeNull();
    expect(detected.suggestedCollector?.traces).toBe("http://local.test/v1/traces");
  }));

test("signal-specific headers override general headers without exposing values or private URL paths", () => {
  const collector = collectorFromEnvironment({
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.test",
    OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20general",
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-key=private%3Dsecret",
  });

  expect(collector?.headers).toEqual({ "x-key": "private=secret" });
  expect(collector?.logHeaders).toEqual({ authorization: "Bearer general" });
  expect(publicCollector(collector)).toEqual({
    url: "https://collector.test/v1/traces",
    headerNames: ["x-key"],
    passesAppHeaders: false,
  });
  expect(
    publicCollector(
      collectorFromEnvironment({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.test/private-path-token",
      })
    )
  ).toBeNull();
  expect(
    publicCollector(
      collectorFromEnvironment({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.test/v1/traces?key=secret",
      })
    )
  ).toBeNull();
});

test("checkout discovery refuses symlinks and never evaluates shell substitutions", () =>
  fixture(async (root) => {
    const external = await mkdtemp("/tmp/p1-outside-");

    try {
      await writeFile(join(external, "secret"), "OTEL_EXPORTER_OTLP_ENDPOINT=https://outside.test");
      await symlink(join(external, "secret"), join(root, ".env.local"));
      await writeFile(
        join(root, ".env"),
        "OTEL_EXPORTER_OTLP_ENDPOINT=$(touch /tmp/p1-should-not-execute)"
      );
      expect((await detectExporters(root, {})).suggestedCollector).toBeNull();
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  }));

test("Axiom dependency and environment prefill only credential-free metadata", () =>
  fixture(async (root) => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "@axiomhq/js": "1" } })
    );

    const result = await detectExporters(root, {
      AXIOM_TOKEN: "private-token",
      AXIOM_DATASET: "private-dataset",
    });

    expect(
      result.detectedExporters.some((e) => e.kind === "axiom" && e.file === "package.json")
    ).toBe(true);
    expect(publicCollector(result.suggestedCollector)).toEqual({
      url: "https://api.axiom.co/v1/traces",
      headerNames: ["authorization", "x-axiom-dataset"],
      passesAppHeaders: false,
    });
    expect(JSON.stringify(result.detectedExporters)).not.toContain("private-");
  }));

for (const [file, source] of [
  ["AXIOM_URL=https://file.test\nAXIOM_TOKEN=file-token", { AXIOM_DATASET: "launch-dataset" }],
  ["AXIOM_DATASET=file-dataset", { AXIOM_URL: "https://launch.test", AXIOM_TOKEN: "launch-token" }],
] as const)
  test("partial vendor configuration never borrows credentials from the other source", () =>
    fixture(async (root) => {
      await writeFile(join(root, ".env"), file);
      const detected = await detectExporters(root, source);
      expect(detected.launchVendorCollector).toBeNull();
      expect(detected.suggestedCollector).toBeNull();
    }));

for (const [label, code, duplicate] of [
  [
    "explicit exporter with default processors",
    'import { registerOTel } from "@vercel/otel";\nregisterOTel({ traceExporter: new OTLPTraceExporter({url:"https://vendor.test/v1/traces"}) });',
    true,
  ],
  [
    "aliased registerOTel",
    'import { registerOTel as setup } from "@vercel/otel";\nsetup({ traceExporter: new OTLPTraceExporter({url:"https://vendor.test/v1/traces"}) });',
    true,
  ],
  [
    "only dependency and comments",
    '// traceExporter: vendor\nconst s = "traceExporter: vendor";',
    false,
  ],
  [
    "custom processors",
    'import { registerOTel } from "@vercel/otel";\nregisterOTel({ traceExporter: new OTLPTraceExporter({url:"https://vendor.test/v1/traces"}), spanProcessors: [] });',
    false,
  ],
  [
    "no explicit exporter",
    'import { registerOTel } from "@vercel/otel";\nregisterOTel({serviceName:"app"});',
    false,
  ],
  [
    "exporter redirected by injected env",
    'import {registerOTel} from "@vercel/otel"; registerOTel({traceExporter:new OTLPTraceExporter({url:process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT})});',
    false,
  ],
  [
    "unknown exporter variable",
    'import {registerOTel} from "@vercel/otel"; registerOTel({traceExporter:vendor});',
    false,
  ],
  [
    "automatic processor explicitly retained",
    'import {registerOTel} from "@vercel/otel"; registerOTel({traceExporter:new OTLPTraceExporter({url:"https://vendor.test/v1/traces"}),spanProcessors:["auto"]});',
    true,
  ],
] as const)
  test(`Vercel detection: ${label}`, () =>
    fixture(async (root) => {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ dependencies: { "@vercel/otel": "2.1.1" } })
      );
      await writeFile(join(root, "instrumentation.ts"), code);
      const result = await detectExporters(root, {});
      expect(result.detectedExporters.some((e) => e.alreadyExporting)).toBe(duplicate);
    }));
