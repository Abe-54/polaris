/**
 * The Bun a sealed Daemon runs the Simulator's tools with (ADR 0108): Oven's own release of the
 * Daemon's Bun version, signed by Oven. The archive's size and hash are the release's
 * `SHASUMS256.txt`; the binary's are the archive's own. A Bun upgrade changes every entry.
 */
import type { PinnedFile } from "../../prediction/managed/catalog.ts";

export const BUN_RUNTIME_VERSION = "1.4.4";

/** A release archive and the `bun` it unpacks, at its path inside the archive. */
export interface PinnedBunRuntime {
  readonly archive: PinnedFile;
  readonly binary: { readonly path: string; readonly sizeBytes: number; readonly sha256: string };
}

const release = (name: string) =>
  `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_RUNTIME_VERSION}/${name}`;

/** Keyed by `runtimePlatform()`. Only a darwin release Daemon is sealed, and only arm64 ships. */
export const BUN_RUNTIME_BUILDS = {
  "darwin-arm64": {
    archive: {
      name: "bun-darwin-aarch64.zip",
      url: release("bun-darwin-aarch64.zip"),
      sizeBytes: 40_323_673,
      sha256: "c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510",
    },
    binary: {
      path: "bun-darwin-aarch64/bun",
      sizeBytes: 88_660_864,
      sha256: "0a2237cdcfa0d16ef501d9acca9f0026309ef348bea7393a64e8d1e3609565cc",
    },
  },
} satisfies Readonly<Record<string, PinnedBunRuntime>>;
