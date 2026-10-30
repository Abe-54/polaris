/**
 * The agent-browser release the Daemon installs (Apache-2.0, github.com/vercel-labs/agent-browser,
 * tag v0.41.0 at commit 1453dd37a40c730fe00f592bc32198a896ff8747). Sizes and hashes are the
 * release's own asset digests; a bump changes the version, the commit and every entry.
 */
import type { PinnedFile } from "../../prediction/managed/catalog.ts";

export const AGENT_BROWSER_VERSION = "0.41.0";

export const AGENT_BROWSER_COMMIT = "1453dd37a40c730fe00f592bc32198a896ff8747";

const release = (asset: string) =>
  `https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/${asset}`;

const pinned = (name: string, sizeBytes: number, sha256: string): PinnedFile => ({
  name,
  url: release(name),
  sizeBytes,
  sha256,
});

/** Keyed by `runtimePlatform()`; each asset is the bare binary, no archive. */
export const AGENT_BROWSER_ASSETS = {
  "darwin-arm64": pinned(
    "agent-browser-darwin-arm64",
    15_902_704,
    "a402fef2489c221b17522aa21f103ca5dc47f00ff5879d4a72c39881544730ab"
  ),
  "darwin-x64": pinned(
    "agent-browser-darwin-x64",
    17_572_952,
    "f108d4aa02f41eee05d6b1b05817475fd5d576d802826783ef80800da16f33e2"
  ),
  "linux-arm64": pinned(
    "agent-browser-linux-arm64",
    15_952_784,
    "e196e9cabe6cb1b01bd5912973628361b9f40a332683a12426abad007f0d3589"
  ),
  "linux-x64": pinned(
    "agent-browser-linux-x64",
    18_432_952,
    "399c7e9f06bd29aa933fdf25c0bd958eea06927fc0ce6f536ba6347aabd64628"
  ),
  "linux-arm64-musl": pinned(
    "agent-browser-linux-musl-arm64",
    15_768_728,
    "77d0dd11dd5e2e9b30e4987603960c2a3f9b4794af782292259a90f3cc1010a1"
  ),
  "linux-x64-musl": pinned(
    "agent-browser-linux-musl-x64",
    18_240_608,
    "9585897e9453517683a4ca42f3c3f8d8376282f3160268d911ed219b2e0ad62a"
  ),
  "win32-x64": pinned(
    "agent-browser-win32-x64.exe",
    18_057_728,
    "dee86b78071cbe7217f71ec1c9df6a50efa73cd44d64a18877bb36556fc8e270"
  ),
} satisfies Readonly<Record<string, PinnedFile>>;
