import type { DetectedTraceExporter } from "@polaris/protocol";
import { expect, test } from "bun:test";
import {
  checkForwardUrl,
  exporterLocation,
  fixedExporters,
  forwardCaption,
  headersLine,
} from "./model.ts";
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
  expect(checkForwardUrl(url, false).ok).toBe(ok);
});

test("an emptied field clears a saved collector, and asks for one when none is saved", () => {
  expect(checkForwardUrl("  ", true)).toEqual({ ok: true, url: null });
  expect(checkForwardUrl("", false)).toEqual({ ok: false, reason: "Enter the collector's URL" });
});

test("evidence from process variables reads as the environment, never as a file:line", () => {
  const env = { ...at("otlp-env", 1), file: "environment" };

  expect(exporterLocation(env)).toBe("the environment");
  expect(exporterLocation(at("fixed-url", 12))).toBe("src/otel.ts:12");
  expect(forwardCaption({ ...FRESH_SETTINGS, forwardTo: null, detectedExporters: [env] })).toBe(
    "Found an exporter in the environment. Add the collector it sends to."
  );
});

test("repository collectors are described as unsaved suggestions until a target is saved", () => {
  const detectedExporters = [{ ...at("otlp-env", 1), file: ".env" }];

  expect(forwardCaption({ ...FRESH_SETTINGS, forwardTo: null, detectedExporters })).toBe(
    "Suggested collector from .env. Save its URL to forward traces."
  );

  const saved = {
    ...FRESH_SETTINGS,
    detectedExporters,
    forwardTo: { url: "https://chosen.test/v1/traces", headerNames: [] },
  };

  expect(forwardCaption({ ...saved, forwarding: true })).toBe(
    "A copy of each trace goes on to this collector."
  );
  expect(forwardCaption({ ...saved, forwarding: false })).toBe(
    "Forwarding is off. Turn it on to send a copy to this collector."
  );
});

test("header copy names configured credentials and limits app headers to the launch origin", () => {
  const target = {
    url: "https://collector.test/v1/traces",
    headerNames: ["authorization", "x-key"],
  };

  expect(headersLine({ ...target, passesAppHeaders: true })).toBe(
    "Headers authorization · x-key, and the headers your app sends to https://collector.test"
  );
  expect(headersLine({ ...target, passesAppHeaders: false })).toBe("Headers authorization · x-key");
  expect(headersLine({ ...target, headerNames: [], passesAppHeaders: false })).toBe(
    "No configured headers"
  );
});
