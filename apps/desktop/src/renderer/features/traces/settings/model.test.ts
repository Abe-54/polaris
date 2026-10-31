import type { DetectedTraceExporter } from "@polaris/protocol";
import { expect, test } from "bun:test";
import { checkForwardUrl, fixedExporters } from "./model.ts";

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
