/**
 * The OpenCode versions the driver speaks to. It drives the v1 HTTP API; OpenCode 2 replaced it
 * with a new API under `/api` (ENG-571), so a 2.x install is refused with this plain reason.
 * No imports: availability probes read it without loading the driver.
 */

/** Why this OpenCode can't be driven, or null when it can (or its version is unknown). */
export const unsupportedOpenCode = (version: string | null): string | null => {
  const major = version === null ? Number.NaN : Number.parseInt(version, 10);

  return Number.isNaN(major) || major < 2
    ? null
    : `OpenCode ${version} isn't supported yet: Polaris works with OpenCode 1 (1.18.33 or newer)`;
};
