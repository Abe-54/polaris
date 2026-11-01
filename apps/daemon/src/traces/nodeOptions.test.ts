import { expect, test } from "bun:test";
import { appendNodeImport } from "./nodeOptions.ts";

test("Node imports compose with flags and a preceding bootstrap without changing their bytes", () => {
  const previous = '--no-warnings --import="file:///tmp/inspector.mjs"';
  const next = appendNodeImport(previous, "/tmp/register here.mjs");

  expect(next).toBe(`${previous} --import "file:///tmp/register%20here.mjs"`);
  expect(appendNodeImport(next, "/tmp/register here.mjs")).toBe(next);
});

for (const existing of [
  '--import "file:///tmp/register%20here.mjs" --enable-source-maps',
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
    '--title="/tmp/register.mjs" --import "file:///tmp/register.mjs"'
  );
});
