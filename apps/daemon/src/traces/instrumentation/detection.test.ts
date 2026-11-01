import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detectFixedExporters, fixedExporterChange, fixedExporterLines } from "./detection.ts";

const fixture = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp("/tmp/p3-detection-");

  try {
    execFileSync("git", ["init", "--quiet", root]);
    await writeFile(
      join(root, "package.json"),
      '{"dependencies":{"@opentelemetry/sdk-node":"0.300.0"}}'
    );
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const fixed = "new OTLPTraceExporter({\n  url: 'https://vendor.example/v1/traces',\n});";

test("detection names the literal url's file:line only after a launch without arriving spans", () =>
  fixture(async (root) => {
    await writeFile(join(root, "instrumentation.ts"), fixed);
    const options = { checkout: root, appRan: true, spansArrived: false };
    const detected = await detectFixedExporters(options);
    expect(detected).toEqual([
      {
        kind: "fixed-url",
        file: "instrumentation.ts",
        line: 2,
        runtime: null,
        alreadyExporting: false,
      },
    ]);
    expect(JSON.stringify(detected)).not.toContain("vendor.example");
    expect(fixedExporterChange).toContain(
      "url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? existingVendorUrl,"
    );
    expect(await detectFixedExporters({ ...options, appRan: false })).toEqual([]);
    expect(await detectFixedExporters({ ...options, spansArrived: true })).toEqual([]);
    await writeFile(join(root, "package.json"), '{"dependencies":{"unrelated":"1.0.0"}}');
    expect(await detectFixedExporters(options)).toEqual([]);
  }));

test("bounded discovery respects gitignore, regular files and checkout containment", () =>
  fixture(async (root) => {
    await writeFile(join(root, ".gitignore"), "ignored/\n");
    await mkdir(join(root, "ignored"));
    await writeFile(join(root, "ignored/fixed.ts"), fixed);
    await writeFile(join(root, "large.ts"), fixed + " ".repeat(65536));
    const outside = await mkdtemp("/tmp/p3-detection-outside-");

    try {
      await writeFile(join(outside, "fixed.ts"), fixed);
      await symlink(join(outside, "fixed.ts"), join(root, "symlink.ts"));
      await symlink(outside, join(root, "linked"));
      expect(
        await detectFixedExporters({ checkout: root, appRan: true, spansArrived: false })
      ).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  }));

test("source detection excludes comments, examples, unrelated URLs and environment fallbacks", () => {
  expect(
    fixedExporterLines(
      `// ${fixed}\n/* ${fixed} */\nconst example = ${JSON.stringify(fixed)};\nnew Client({url:'https://other.example'});`
    )
  ).toEqual([]);
  expect(
    fixedExporterLines(
      "new OTLPTraceExporter({url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? 'https://vendor.example'})"
    )
  ).toEqual([]);
  expect(fixedExporterLines("new OTLPTraceExporter({url: `https://${host}/v1/traces`})")).toEqual(
    []
  );
  expect(fixedExporterLines(`\n\n${fixed}`)).toEqual([4]);
});

test("source detection finds a literal endpoint after nested exporter headers", () => {
  expect(
    fixedExporterLines(
      "new OTLPTraceExporter({\n headers: {Authorization: token},\n url: 'https://vendor.example/v1/traces',\n})"
    )
  ).toEqual([3]);
});

test("discovery caps exporter evidence without recording URL content", () =>
  fixture(async (root) => {
    await writeFile(join(root, "many.ts"), `${fixed}\n`.repeat(80));

    const result = await detectFixedExporters({
      checkout: root,
      appRan: true,
      spansArrived: false,
    });

    expect(result).toHaveLength(32);
    expect(result[31]?.line).toBe(95);
  }));

test("a quoted exporter url property is detected", () => {
  expect(
    fixedExporterLines("new OTLPTraceExporter({ 'url': 'https://vendor.example/v1/traces' })")
  ).toEqual([1]);
});
