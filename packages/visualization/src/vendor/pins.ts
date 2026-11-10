/** The vendored libraries, pinned by the sha256 of the exact upstream file (ADR 0101). */
export interface LibraryPin {
  /** The module under `src/vendor/` holding the file's text. */
  readonly module: string;
  readonly npm: string;
  readonly version: string;
  /** The file inside the npm tarball. */
  readonly file: string;
  /** SPDX licence id. */
  readonly license: string;
  readonly upstreamLicense: string;
  /** The licence text's copy under `vendor/`. */
  readonly licenseFile: string;
  readonly sha256: string;
  /** The global the file defines in the frame. */
  readonly global: string;
}

export const CHART_JS_PIN: LibraryPin = {
  module: "chartjs",
  npm: "chart.js",
  version: "4.6.1",
  file: "dist/chart.umd.min.js",
  license: "MIT",
  upstreamLicense: "LICENSE.md",
  licenseFile: "LICENSE-chart.js.md",
  sha256: "87364cc2b2a76a6684929e7d6b80b18a897794db38400caff1fcf1791c6925d2",
  global: "Chart",
};

export const D3_PIN: LibraryPin = {
  module: "d3",
  npm: "d3",
  version: "7.9.0",
  file: "dist/d3.min.js",
  license: "ISC",
  upstreamLicense: "LICENSE",
  licenseFile: "LICENSE-d3.txt",
  sha256: "f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539",
  global: "d3",
};

export const LIBRARY_PINS: ReadonlyArray<LibraryPin> = [CHART_JS_PIN, D3_PIN];
