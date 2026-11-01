import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";
import {
  appendNodeImport,
  instrumentationImport,
  stripNodeInstrumentation,
} from "./nodeOptions.ts";

test("Node imports compose with flags and a preceding bootstrap without changing their bytes", () => {
  const previous = '--no-warnings --import="file:///tmp/inspector.mjs"';
  const next = appendNodeImport(previous, "/tmp/register here.mjs");

  expect(next).toBe(
    `${previous} --import "${pathToFileURL(resolve("/tmp/register here.mjs")).href}"`
  );
  expect(appendNodeImport(next, "/tmp/register here.mjs")).toBe(next);
});

for (const existing of [
  `--import "${pathToFileURL(resolve("/tmp/register here.mjs")).href}" --enable-source-maps`,
  '--import="/tmp/register here.mjs" --enable-source-maps',
  "--import /tmp/register.mjs",
]) {
  test(`existing import is retained once: ${existing}`, () => {
    const path = existing.includes("here") ? "/tmp/register here.mjs" : "/tmp/register.mjs";

    expect(appendNodeImport(existing, path)).toBe(existing);
  });
}

test("an unrelated option value is not mistaken for an import", () => {
  expect(appendNodeImport('--title="/tmp/register.mjs"', "/tmp/register.mjs")).toBe(
    `--title="/tmp/register.mjs" --import "${pathToFileURL(resolve("/tmp/register.mjs")).href}"`
  );
});

for (const old of [
  '--import="file:///tmp/node-instrumentation/old/register.mjs"',
  '--import "/tmp/node-instrumentation/old/register.mjs"',
  '--import "C:\\\\Users\\\\me\\\\node-instrumentation\\\\old\\\\register.mjs"',
  `--import ${JSON.stringify(instrumentationImport("/tmp/node-instrumentation/old/register.mjs"))}`,
]) {
  test(`replaces an inherited Polaris import and keeps the inspector: ${old}`, () => {
    const inspector = '--import="file:///tmp/inspector.mjs" --no-warnings';

    const result = appendNodeImport(
      `${old} ${inspector}`,
      instrumentationImport("/tmp/node-instrumentation/new/register.mjs")
    );

    expect(result).not.toContain("old");
    expect(result).toContain(inspector);
    expect(stripNodeInstrumentation(result)).toBe(inspector);
  });
}
