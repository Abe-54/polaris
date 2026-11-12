import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFromRoot, DAEMON_BUILD_OPTIONS } from "./daemonBundle.ts";

const dir = mkdtempSync(join(tmpdir(), "polaris-bundle-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const write = (path: string, text: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
};

write(
  "src/lib.ts",
  [
    "export class DataError extends Error {}",
    "export const ws = (id: string): never => {",
    "  throw new DataError(`branch ${id} does not exist`);",
    "};",
  ].join("\n")
);

write(
  "src/lazy.ts",
  ["export const boom = () => {", '  throw new Error("lazy");', "};"].join("\n")
);

write(
  "src/main.ts",
  [
    'import { ws } from "./lib.ts";',
    "const stack = (f: () => unknown) => Promise.resolve().then(f).catch((e: Error) => e.stack);",
    'console.log(await stack(() => ws("7mmvvc5m9g0t")));',
    'console.log(await stack(async () => (await import("./lazy.ts")).boom()));',
  ].join("\n")
);

// Windows compiles to an .exe; naming it here keeps Bun from adding the extension.
const name = process.platform === "win32" ? "fixture.exe" : "fixture";

const outfile = join(dir, "out", name);

test("a compiled bundle's stacks name repo-relative source files and lines", async () => {
  const result = await buildFromRoot(dir, {
    ...DAEMON_BUILD_OPTIONS,
    entrypoints: [join(dir, "src/main.ts")],
    compile: { outfile, autoloadDotenv: false, autoloadBunfig: false },
  });

  expect(result.logs.map((log) => log.message)).toEqual([]);
  expect(readdirSync(join(dir, "out"))).toEqual([name]);

  const proc = Bun.spawn([outfile], { cwd: tmpdir(), stdout: "pipe", stderr: "inherit" });
  const stdout = await new Response(proc.stdout).text();

  expect(await proc.exited).toBe(0);
  // Frames keep the minified function names; the files and lines are the source's.
  expect(stdout).toMatch(/branch 7mmvvc5m9g0t does not exist\n {4}at \S+ \(src\/lib\.ts:3:\d+\)/);
  // The lazily imported chunk is mapped too.
  expect(stdout).toMatch(/Error: lazy\n {4}at \S+ \(src\/lazy\.ts:2:\d+\)/);
  expect(stdout).not.toContain("$bunfs");
  expect(stdout).not.toContain(dir);
}, 60_000);
