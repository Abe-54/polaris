import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CurrentLink, pointCurrent, readCurrent, versionOfTarget } from "./current.ts";

const dirs: Array<string> = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempDir(dir);
});

/** A `bin` with two installed versions, each with a marker file. */
const binWithVersions = () => {
  const bin = newTempDir("polaris-current-");
  dirs.push(bin);

  for (const version of ["0.2.0", "0.2.1"]) {
    mkdirSync(join(bin, version));
    writeFileSync(join(bin, version, "marker"), version);
  }

  return bin;
};

describe("versionOfTarget", () => {
  test.each([
    ["0.2.0", "0.2.0"],
    ["C:\\Users\\lucas\\.polaris\\bin\\0.2.0", "0.2.0"],
    ["\\\\?\\C:\\Users\\lucas\\.polaris\\bin\\0.2.0\\", "0.2.0"],
    ["/home/pi/.polaris/bin/0.2.0-dev.12.abc", "0.2.0-dev.12.abc"],
  ])("%s names %s", (target, version) => {
    expect(versionOfTarget(target)).toBe(version);
  });
});

// Elsewhere a junction request makes an absolute symlink, so both swaps run on macOS and Linux;
// Windows only uses junctions (a symlink needs a privilege, and can't be renamed over).
const links: Array<CurrentLink> =
  process.platform === "win32" ? ["junction"] : ["symlink", "junction"];

describe.each(links)("bin/current as a %s", (link) => {
  test("a first install points current at the version, and paths through it reach that version", () => {
    const bin = binWithVersions();

    expect(pointCurrent(bin, "0.2.0", link)).toBe(true);
    expect(readCurrent(bin)).toBe("0.2.0");
    expect(readFileSync(join(bin, "current", "marker"), "utf8")).toBe("0.2.0");
  });

  test("repointing switches the version and leaves no temporary or set-aside links", () => {
    const bin = binWithVersions();
    pointCurrent(bin, "0.2.0", link);

    expect(pointCurrent(bin, "0.2.1", link)).toBe(true);
    expect(readFileSync(join(bin, "current", "marker"), "utf8")).toBe("0.2.1");
    expect(readdirSync(bin).toSorted()).toEqual(["0.2.0", "0.2.1", "current"]);
    expect(readFileSync(join(bin, "0.2.0", "marker"), "utf8")).toBe("0.2.0");
  });

  test("pointing at the version it already names changes nothing", () => {
    const bin = binWithVersions();
    pointCurrent(bin, "0.2.0", link);

    expect(pointCurrent(bin, "0.2.0", link)).toBe(false);
  });

  test("a stale temporary link from an interrupted install is replaced", () => {
    const bin = binWithVersions();
    pointCurrent(bin, "0.2.0", link);
    // The leftover a crash between creating and renaming the temporary link would leave.
    symlinkSync(join(bin, "0.2.0"), join(bin, `current.tmp-${process.pid}`), "junction");

    expect(pointCurrent(bin, "0.2.1", link)).toBe(true);
    expect(readCurrent(bin)).toBe("0.2.1");
  });
});

test("no current reads as null", () => {
  expect(readCurrent(binWithVersions())).toBeNull();
});
