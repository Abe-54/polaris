import { tempDir } from "../../platform/tempDir.testing.ts";
import { rm, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { HostId } from "@polaris/protocol";
import { createInstaller, type InstallerAdapters, type ArtifactPayload } from "./index.ts";
import { digest } from "./validation.ts";

export const hostId = HostId.make("00000000-0000-4000-8000-000000000001");

export const platform = { os: "darwin", arch: "arm64", libc: "none" } as const;

export function artifactFixture(version = "1.0.0") {
  const bytes = Buffer.from(`synthetic-archive-${version}`);
  const notice = Buffer.from("Synthetic permissive notice; no upstream source");

  const manifestBytes = Buffer.from(
    JSON.stringify({
      artifactId: "fake",
      artifactIntegrity: digest(bytes),
      coverage: "complete",
      notices: [{ path: "LICENSE", integrity: digest(notice) }],
    })
  );

  const tool = {
    id: "fake-tool",
    disposition: "offered",
    version,
    source: "https://invalid.example/source",
    license: "MIT",
    artifacts: [
      {
        id: "fake",
        format: "tar.gz",
        url: "https://invalid.example/fake",
        integrity: digest(bytes),
        platforms: [platform],
        entry: "bin/tool",
        bundle: null,
        audit: "verified",
        auditRoot: digest(manifestBytes),
        auditReason: "Synthetic fixture only",
      },
    ],
    requirements: [],
    argv: [],
    environment: {},
    limitations: [],
    developerCompanions: [{ id: "future-developer", required: true }],
  };

  const payload: ArtifactPayload = {
    manifestBytes,
    entries: [
      { path: "bin/tool", kind: "file", mode: 0o755, bytes: Buffer.from(`fake-tool-${version}`) },
      { path: "LICENSE", kind: "file", mode: 0o644, bytes: notice },
    ],
  };

  return { bytes, payload, tool };
}

export async function fixture(overrides: Partial<InstallerAdapters> = {}, limits = {}) {
  const parent = await realpath(tempDir("m31-i0-"));
  const source = artifactFixture();
  let downloads = 0;
  let decodes = 0;

  const installer = await createInstaller({
    root: join(parent, "private"),
    hostId,
    platform,
    limits,
    adapters: {
      async *download() {
        downloads++;
        yield source.bytes;
      },
      async decode() {
        decodes++;

        return source.payload;
      },
      async approve(exact) {
        return { approved: true, identity: exact.identity };
      },
      ...overrides,
    },
  }).catch(async (cause) => {
    await rm(parent, { recursive: true, force: true });
    throw cause;
  });

  return {
    installer,
    source,
    parent,
    request: { tool: source.tool, connected: true, probes: [], intent: "install" } as const,
    counts: () => ({ downloads, decodes }),
    async debris() {
      const root = join(parent, "private");
      const files = await readdir(root, { recursive: true });

      return files.filter(
        (file) =>
          file.includes(".stage-") || file.includes(".active-") || file.endsWith("install.lock")
      );
    },
    async close() {
      await installer.dispose();
      await rm(parent, { recursive: true, force: true });
    },
  };
}
