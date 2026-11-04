/**
 * What pre-push tests on Windows: every changed package but the POSIX-only ones
 * (`tooling/ci/windows-skipped-packages.txt`), whose Windows-safe files CI lists
 * (`tooling/ci/windows-client-tests.txt`) run instead.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A package turbo would test: its name and its directory, relative to the root. */
export interface Affected {
  readonly name: string;
  readonly directory: string;
}

export interface WindowsTests {
  /** The changed packages tested whole. */
  readonly packages: ReadonlyArray<string>;
  /** The changed POSIX-only packages, left to CI. */
  readonly skipped: ReadonlyArray<string>;
  /** Their Windows-safe test files and folders. */
  readonly files: ReadonlyArray<string>;
}

/** A list file's entries: one per line, without `#` comments or blank lines. */
export const listEntries = (text: string): ReadonlyArray<string> =>
  text.split("\n").flatMap((line) => {
    const entry = line.replace(/#.*/, "").trim();

    return entry === "" ? [] : [entry];
  });

const within = (path: string, directory: string) =>
  path === directory || path.startsWith(`${directory}/`);

export const planWindowsTests = (
  affected: ReadonlyArray<Affected>,
  posixOnly: ReadonlySet<string>,
  windowsFiles: ReadonlyArray<string>
): WindowsTests => {
  const skipped = affected.filter((pkg) => posixOnly.has(pkg.name));

  return {
    packages: affected.flatMap((pkg) => (posixOnly.has(pkg.name) ? [] : [pkg.name])),
    skipped: skipped.map((pkg) => pkg.name),
    files: windowsFiles.filter((file) => skipped.some((pkg) => within(file, pkg.directory))),
  };
};

/** The two lists, read from `root`. */
export const windowsLists = (root: string) => ({
  posixOnly: new Set(
    listEntries(readFileSync(join(root, "tooling/ci/windows-skipped-packages.txt"), "utf8"))
  ),
  windowsFiles: listEntries(
    readFileSync(join(root, "tooling/ci/windows-client-tests.txt"), "utf8")
  ),
});
