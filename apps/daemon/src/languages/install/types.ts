import { Schema } from "effect";
import {
  HostId,
  LanguageTool,
  LanguagePlatform,
  LanguageJsonObject,
  LanguageInstallProgress,
} from "@polaris/protocol";
import type { Artifact, Platform, Tool } from "../catalog/model.ts";
import type { ArchiveEntry } from "../catalog/packaging.ts";
import type { ProbeFact } from "../catalog/selection.ts";

export interface InstallLimits {
  readonly downloadBytes: number;
  readonly expandedBytes: number;
  readonly entries: number;
  readonly versions: number;
  readonly fileBytes: number;
  readonly metadataBytes: number;
  readonly receiptBytes: number;
  readonly jobs: number;
  readonly waiters: number;
  readonly listeners: number;
  readonly timeoutMs: number;
}

export const defaultLimits: InstallLimits = {
  downloadBytes: 32 * 1024 * 1024,
  expandedBytes: 64 * 1024 * 1024,
  fileBytes: 16 * 1024 * 1024,
  entries: 4096,
  versions: 16,
  metadataBytes: 1024 * 1024,
  receiptBytes: 1024 * 1024,
  jobs: 4,
  waiters: 64,
  listeners: 64,
  timeoutMs: 120_000,
};

export interface ArtifactPayload {
  readonly manifestBytes: Uint8Array;
  readonly entries: ReadonlyArray<ArchiveEntry>;
  readonly packagingManifestBytes?: Uint8Array;
  readonly thirdPartyDiscovery?: boolean;
}

export interface ExactArtifact {
  readonly hostId: HostId;
  readonly tool: Tool;
  readonly artifact: Artifact;
  readonly platform: Platform;
  readonly identity: string;
  readonly descriptor: typeof LanguageJsonObject.Type;
}

export interface ApprovalDecision {
  readonly approved: boolean;
  readonly identity: string;
}

export interface InstallerAdapters {
  /** Must release transport resources on abort; never write to an installation root. */
  readonly download: (exact: ExactArtifact, signal: AbortSignal) => AsyncIterable<Uint8Array>;
  /** Decode verified bytes without executing code or writing files. Core validates all output. */
  readonly decode: (
    bytes: Uint8Array,
    exact: ExactArtifact,
    signal: AbortSignal
  ) => Promise<ArtifactPayload>;
  /** I1 supplies a session barrier here; reject while a tool version is in use. */
  readonly beforeSelect?: (exact: ExactArtifact, signal: AbortSignal) => Promise<void>;
  /** Release a selection reservation only after the underlying job has settled, including cancellation. */
  readonly afterSelection?: (exact: ExactArtifact) => Promise<void>;
  readonly approve?: (exact: ExactArtifact, signal: AbortSignal) => Promise<ApprovalDecision>;
  /** Test seam: runs after a recovery scan records its launch count and before it reads the tool root. */
  readonly beforeRecoveryScan?: (toolId: string) => Promise<void>;
}

export interface InstallRequest {
  readonly tool: unknown;
  readonly probes: ReadonlyArray<ProbeFact>;
  readonly connected: boolean;
  readonly intent: "encounter" | "install" | "update";
}

export interface InstalledVersion {
  readonly identity: string;
  readonly version: string;
  readonly artifactId: string;
  readonly integrity: string;
  readonly directory: string;
  readonly descriptor: typeof LanguageJsonObject.Type;
}

export interface InstallHandle {
  readonly jobId: string;
  readonly result: Promise<InstalledVersion>;
  /** Detach this consumer. The shared job aborts only when its last consumer leaves. */
  readonly cancel: () => void;
}

export interface InstallerOptions {
  readonly root: string;
  readonly hostId: HostId;
  readonly platform: Platform;
  readonly adapters: InstallerAdapters;
  readonly limits?: Partial<InstallLimits>;
  readonly sizeProfile?: "upstream-runtime";
}

/** Official Node archives expand to ~200 MiB; these caps apply only to the private runtime profile. */
export const upstreamRuntimeLimits: InstallLimits = {
  ...defaultLimits,
  downloadBytes: 96 * 1024 * 1024,
  expandedBytes: 256 * 1024 * 1024,
  fileBytes: 128 * 1024 * 1024,
  entries: 32768,
  receiptBytes: 2 * 1024 * 1024,
};

export type Progress = typeof LanguageInstallProgress.Type;

/** Validate known contract fields but retain future JSON metadata, including developerCompanions. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- External catalog boundary validates schemas while retaining future JSON metadata.
export function descriptor(input: unknown, maxBytes: number) {
  const raw = Schema.decodeUnknownSync(LanguageJsonObject)(input);
  const serialized = JSON.stringify(raw);

  if (Buffer.byteLength(serialized) > maxBytes) throw new Error("descriptor-too-large");
  const snapshot = Schema.decodeUnknownSync(LanguageJsonObject)(JSON.parse(serialized));
  const tool = Schema.decodeUnknownSync(LanguageTool)(snapshot);

  return { tool, raw: snapshot };
}

export const validateHost = Schema.decodeUnknownSync(HostId);

export const validatePlatform = Schema.decodeUnknownSync(LanguagePlatform);
