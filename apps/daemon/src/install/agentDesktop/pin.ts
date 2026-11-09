/**
 * The agent-desktop release the Daemon installs (Apache-2.0, github.com/vercel-labs/agent-desktop,
 * tag v1.2.0 at commit 2b0a7334fc111730454b726e6800aa41cdafc093). Archive sizes and hashes are the
 * release's own asset digests (and its checksums.txt); binary sizes are the archives' listings.
 * A bump changes the version, the commit and every entry.
 */
import type { PinnedFile } from "../../prediction/managed/catalog.ts";

export const AGENT_DESKTOP_VERSION = "1.2.0";

export const AGENT_DESKTOP_COMMIT = "2b0a7334fc111730454b726e6800aa41cdafc093";

/** A release archive and the binary it unpacks, beside its helpers. */
export interface PinnedBuild {
  readonly archive: PinnedFile;
  readonly binary: { readonly name: string; readonly sizeBytes: number };
}

const build = (
  target: string,
  sizeBytes: number,
  sha256: string,
  binary: PinnedBuild["binary"]
): PinnedBuild => {
  const name = `agent-desktop-v${AGENT_DESKTOP_VERSION}-${target}.tar.gz`;

  return {
    archive: {
      name,
      url: `https://github.com/vercel-labs/agent-desktop/releases/download/v${AGENT_DESKTOP_VERSION}/${name}`,
      sizeBytes,
      sha256,
    },
    binary,
  };
};

const unix = (sizeBytes: number) => ({ name: "agent-desktop", sizeBytes });

const windows = (sizeBytes: number) => ({ name: "agent-desktop.exe", sizeBytes });

/** Keyed by `runtimePlatform()`. Linux builds link glibc; there is none for musl. */
export const AGENT_DESKTOP_BUILDS = {
  "darwin-arm64": build(
    "aarch64-apple-darwin",
    2_230_641,
    "219813428bb1ad8decae172faed05c5964a2415170df402e2786ccfa6452ba82",
    unix(3_824_448)
  ),
  "darwin-x64": build(
    "x86_64-apple-darwin",
    2_359_765,
    "d9dc50226f28d7fc86a2f5b0945f0c206dff6c31e418907749f493b6f9e773e6",
    unix(4_486_048)
  ),
  "linux-arm64": build(
    "aarch64-unknown-linux-gnu",
    3_333_305,
    "68e8ebbb4f80e44485d2f1cf972943a38ee43108e2e0ce56bdfa641fd1599f68",
    unix(5_804_456)
  ),
  "linux-x64": build(
    "x86_64-unknown-linux-gnu",
    3_458_001,
    "591ae7f4a38479dc045df97e27447c0c8b530441730ab6b990e27c813162af44",
    unix(7_172_664)
  ),
  "windows-arm64": build(
    "aarch64-pc-windows-msvc",
    1_706_239,
    "d6d8643310c2c13eace2261444d9e4c0d16ca09581f38500983104903604caa6",
    windows(3_373_056)
  ),
  "windows-x64": build(
    "x86_64-pc-windows-msvc",
    1_759_368,
    "a4199f741a441cedd349bf56c5eba01783b1261258b498efeb7ec9945220c3e8",
    windows(3_827_200)
  ),
} satisfies Readonly<Record<string, PinnedBuild>>;
