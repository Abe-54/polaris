/**
 * Repo files any dependency change touches, outside every Task's declared area (ENG-276):
 * manifests, the lockfile, licence exceptions and notices.
 */
const SHARED = new Set([
  "package.json",
  "bun.lock",
  "license-exceptions.json",
  "THIRD_PARTY_NOTICES.md",
]);

/** A package root, by the monorepo's layout: the repo, or `apps/x`, `packages/x`, `extensions/x`. */
const PACKAGE_DEPTH = 2;

const literal = (glob: string) => (glob.split(/[?*[{]/, 1)[0] ?? "").replace(/\/+$/, "");

/** True when an area entry may change dependencies: it names a shared file or spans a package root. */
export const touchesDependencies = (entry: string) => {
  const path = literal(entry);
  const segments = path === "" ? [] : path.split("/");
  const last = segments.at(-1) ?? "";

  return SHARED.has(last) || (!last.includes(".") && segments.length <= PACKAGE_DEPTH);
};

/** The warning for two working Tasks whose areas may both change dependencies; null when not. */
export const sharedFilesWarning = (
  a: { readonly id: string; readonly area: ReadonlyArray<string> },
  b: { readonly id: string; readonly area: ReadonlyArray<string> }
) =>
  a.area.some(touchesDependencies) && b.area.some(touchesDependencies)
    ? `${a.id} and ${b.id} may both change dependencies: Accept's merge regenerates bun.lock and flags THIRD_PARTY_NOTICES.md as stale, but scripts/license-exceptions.json can conflict`
    : null;
