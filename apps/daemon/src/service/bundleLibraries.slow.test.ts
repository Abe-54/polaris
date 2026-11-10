import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE_FILES, BUNDLE_LIBRARY_NAMES, DAEMON_BUNDLE } from "./bundle.ts";
import { embeddedLibraries, foreignLibraries, loadedLibraries } from "./bundleLibraries.ts";
import {
  binaryOf,
  buildDaemon,
  onDarwinArm64,
  runIn,
  signHardened,
  sipEnabled,
} from "./daemonBuild.testing.ts";

const dir = mkdtempSync(join(tmpdir(), "polaris-libraries-test-"));

const marker = join(dir, "planted-ran");

/** A library that says it was loaded: its constructor runs inside whoever opens it. */
const PLANT = `
#include <stdio.h>
#include <stdlib.h>
__attribute__((constructor)) static void planted(void) {
  const char *path = getenv("POLARIS_PLANT_MARKER");
  FILE *file = path ? fopen(path, "a") : NULL;
  if (file) { fputs("ran", file); fclose(file); }
}
`;

/** Bun's name for an embedded library it writes to the temp directory (Bun 1.4.4, `jsc_hooks.rs`). */
const extractedName = (bytes: Buffer, extension: string) =>
  `.bun-${process.getuid!()}-${Bun.hash(bytes).toString(16)}.${extension}`;

/** What Bun's reuse check asks of a file: the name and the size, never the bytes. */
const padded = (plant: Buffer, size: number) => {
  const bytes = Buffer.alloc(size);
  plant.copy(bytes);

  return bytes;
};

const selftest = (binary: string, temp: string) =>
  runIn(dir, [binary, "selftest"], {
    HOME: dir,
    TMPDIR: temp,
    BUN_TMPDIR: temp,
    PATH: "/usr/bin:/bin",
    POLARIS_PLANT_MARKER: marker,
  });

const ran = () => {
  const yes = existsSync(marker);
  rmSync(marker, { force: true });

  return yes;
};

describe.skipIf(!onDarwinArm64)("a darwin Daemon loads only its bundle's libraries", () => {
  let release = "";
  let plant = Buffer.alloc(0);

  beforeAll(async () => {
    const source = join(dir, "plant.c");
    writeFileSync(source, PLANT);

    const [bundle, compiled] = await Promise.all([
      buildDaemon(dir, "release", ["--release"]),
      runIn(dir, ["clang", "-dynamiclib", "-o", join(dir, "plant.dylib"), source]),
    ]);

    if (compiled.code !== 0) throw new Error(`clang failed:\n${compiled.stderr}`);
    release = bundle;
    plant = readFileSync(join(dir, "plant.dylib"));
  }, 300_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a library planted where Bun extracts an embedded one is loaded by a program that embeds it", async () => {
    // The control: the plant is a working exploit of a compiled executable that embeds a library.
    const library = join(release, BUNDLE_FILES["libfff_c.dylib"]);
    const entry = join(dir, "embeds.ts");
    const embedding = join(dir, "embeds");

    writeFileSync(
      entry,
      `import { dlopen } from "bun:ffi";\n` +
        `import path from ${JSON.stringify(library)} with { type: "file" };\n` +
        `dlopen(path, { fff_version: { args: [], returns: "ptr" } });\n`
    );

    const built = await runIn(dir, [
      process.execPath,
      "build",
      "--compile",
      entry,
      "--outfile",
      embedding,
    ]);

    expect(built.code).toBe(0);
    expect(embeddedLibraries(embedding)).toBe(1);

    const temp = join(dir, "temp-embedding");
    mkdirSync(temp);
    const real = readFileSync(library);
    writeFileSync(join(temp, extractedName(real, "dylib")), padded(plant, real.length));
    await runIn(dir, [embedding], { TMPDIR: temp, POLARIS_PLANT_MARKER: marker });

    expect(ran()).toBe(true);
  }, 60_000);

  test("a file planted at each library's extraction path is never loaded", async () => {
    const binary = binaryOf(release);
    const temp = join(dir, "temp-release");
    mkdirSync(temp);

    const planted = BUNDLE_LIBRARY_NAMES.map((name) => {
      const real = readFileSync(join(release, BUNDLE_FILES[name]));
      const extension = name.endsWith(".node") ? "node" : "dylib";
      const file = extractedName(real, extension);
      writeFileSync(join(temp, file), padded(plant, real.length), { mode: 0o600 });

      return file;
    });

    const result = await selftest(binary, temp);

    expect(ran()).toBe(false);
    // It worked from its own libraries, and wrote none of them to the temp directory.
    expect(result.stdout).toContain("fff: ok");
    expect(result.stdout).toContain("rules: ok (ast-grep");
    expect(result.stdout).toContain("libsodium: ok");
    expect(result.code).toBe(0);
    expect(
      readdirSync(temp)
        .filter((file) => file.startsWith(".bun-"))
        .sort()
    ).toEqual(planted.toSorted());
    expect(embeddedLibraries(binary)).toBe(0);
  }, 60_000);

  test("every library it loads is macOS's or a file of its bundle", async () => {
    const binary = binaryOf(release);
    const { code, images } = await loadedLibraries(binary, ["selftest"]);

    expect(code).toBe(0);
    expect(foreignLibraries(binary, images)).toEqual([]);

    // The selftest reached every one of them, so the list above is the whole account.
    for (const name of BUNDLE_LIBRARY_NAMES)
      expect(images).toContain(join(realpathSync(release), BUNDLE_FILES[name]));
  }, 60_000);

  test.skipIf(!sipEnabled)(
    "signed as a release is, it refuses a foreign library put in its bundle",
    async () => {
      const swap = async (name: string, harden: boolean) => {
        const copy = join(dir, name, DAEMON_BUNDLE);
        cpSync(release, copy, { recursive: true });

        if (harden) expect((await signHardened(dir, copy)).code).toBe(0);

        // What a program of the same user can do: copy the signed Daemon and change a library.
        writeFileSync(join(copy, BUNDLE_FILES["libfff_c.dylib"]), plant);
        await selftest(binaryOf(copy), dir);

        return ran();
      };

      expect(await swap("hardened", true)).toBe(false);
      // Without the hardened runtime macOS validates no library: the plant runs.
      expect(await swap("unhardened", false)).toBe(true);
    },
    120_000
  );
});
