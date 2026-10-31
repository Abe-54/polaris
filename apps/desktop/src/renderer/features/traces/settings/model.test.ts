import type { DetectedTraceExporter } from "@polaris/protocol";
import { expect, test } from "bun:test";
import { checkForwardUrl, exporterLocation, fixedExporters, forwardCaption } from "./model.ts";
import { FRESH_SETTINGS } from "./fixtures.ts";

const at = (kind: DetectedTraceExporter["kind"], line: number): DetectedTraceExporter => ({
  kind,
  file: "src/otel.ts",
  line,
  runtime: "node",
  alreadyExporting: false,
});

test("only exporters the environment can't redirect get the fixed-exporter card", () => {
  const found = fixedExporters({
    detectedExporters: [at("otlp-env", 1), at("fixed-url", 2), at("vercel", 3), at("axiom", 4)],
  });

  expect(found.map((e) => e.line)).toEqual([2, 4]);
});

test.each([
  ["https://otel.example.com/v1/traces", true],
  ["http://127.0.0.1:4318/v1/traces", true],
  ["https://me:secret@api.axiom.co/v1/traces", false],
  ["https://api.axiom.co/v1/traces?token=abc", false],
  ["https://api.axiom.co/v1/traces#frag", false],
  ["ftp://api.axiom.co/v1/traces", false],
  ["   ", false],
])("a forward URL %s is accepted: %s", (url, ok) => {
  expect(checkForwardUrl(url).ok).toBe(ok);
});

test("evidence from process variables reads as the environment, never as a file:line", () => {
  const env = { ...at("otlp-env", 1), file: "environment" };

  expect(exporterLocation(env)).toBe("the environment");
  expect(exporterLocation(at("fixed-url", 12))).toBe("src/otel.ts:12");
  expect(forwardCaption({ ...FRESH_SETTINGS, forwardTo: null, detectedExporters: [env] })).toBe(
    "Found an exporter in the environment. Add the collector it sends to."
  );
});
