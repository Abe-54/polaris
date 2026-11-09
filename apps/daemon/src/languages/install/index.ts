import { Schema } from "effect";
import { LanguageError, LanguageInstallProgress } from "@polaris/protocol";
import { preflight } from "../catalog/selection.ts";
import { artifactIdentity } from "./identity.ts";
import { createVersionStorage } from "./storage.ts";
import {
  abortable,
  checkAbort,
  collect,
  failure,
  verifyIntegrity,
  verifyPayload,
} from "./validation.ts";
import {
  defaultLimits,
  upstreamRuntimeLimits,
  descriptor,
  validateHost,
  validatePlatform,
  type ExactArtifact,
  type InstallHandle,
  type InstalledVersion,
  type InstallerOptions,
  type InstallRequest,
  type Progress,
  type InstallLimits,
} from "./types.ts";

interface Waiter {
  resolve: (value: InstalledVersion) => void;
  reject: (error: LanguageError) => void;
}

interface Job {
  readonly exact: ExactArtifact;
  readonly id: string;
  readonly controller: AbortController;
  readonly waiters: Set<Waiter>;
  readonly rollback: boolean;
  done: Promise<void>;
  progress: Progress;
}

const normalizedError = (cause: unknown) =>
  Schema.is(LanguageError)(cause)
    ? cause
    : failure("install-failed", "Installation failed; working version retained", true);

const validateLimits = (limits: InstallLimits, caps = defaultLimits) => {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw failure("invalid-input", "Installer limits must be positive integers");
  }

  for (const key of Object.keys(defaultLimits)) {
    // SAFETY: keys originate from the complete InstallLimits defaults, never from untrusted input.
    const field = key as keyof InstallLimits;

    if (limits[field] > caps[field])
      throw failure("invalid-input", "Installer limits may only lower safety caps");
  }

  return limits;
};

/** Detached construction seam. Caller supplies transport/decoder; exact-artifact approval defaults deny. */
export async function createInstaller(options: InstallerOptions) {
  const hostId = validateHost(options.hostId);
  const platform = validatePlatform(options.platform);
  const caps = options.sizeProfile === "upstream-runtime" ? upstreamRuntimeLimits : defaultLimits;
  const limits = validateLimits({ ...caps, ...options.limits }, caps);
  const storage = await createVersionStorage(options.root, limits, { hostId, platform });
  const jobs = new Map<string, Job>();
  const launches = new Map<string, number>();
  const latest = new Map<string, Progress>();
  const listeners = new Set<(progress: Progress) => void>();
  let disposed = false;
  let waiterCount = 0;
  const cleanupFailures: string[] = [];

  function exactFor(request: InstallRequest): ExactArtifact {
    const { tool, raw } = descriptor(request.tool, limits.metadataBytes);

    if (!request.connected) throw failure("not-connected", "Host is unavailable", true);

    if (tool.disposition !== "offered") throw failure("not-offered", "Tool is not offered");
    const checked = preflight({ tool, platform, probes: request.probes, phase: "install" });

    if (checked.status !== "eligible") throw failure(checked.status, checked.reason, true);

    if (!checked.artifact) throw failure("unsupported-platform", "No matching artifact");

    const identity = artifactIdentity({
      hostId,
      platform,
      descriptor: raw,
      artifact: checked.artifact,
    });

    return { hostId, platform, tool, descriptor: raw, artifact: checked.artifact, identity };
  }

  function emit(
    job: Job,
    phase: Progress["phase"],
    message = "",
    downloadedBytes = job.progress.downloadedBytes
  ) {
    job.progress = LanguageInstallProgress.make({
      ...job.progress,
      phase,
      message,
      downloadedBytes,
      sequence: job.progress.sequence + 1,
    });
    latest.delete(job.exact.tool.id);

    while (latest.size >= 256) latest.delete(latest.keys().next().value!);
    latest.set(job.exact.tool.id, job.progress);

    for (const listener of listeners) {
      try {
        listener(structuredClone(job.progress));
      } catch {
        /* Observer errors do not alter installation outcomes. */
      }
    }
  }

  async function approve(exact: ExactArtifact, signal: AbortSignal) {
    checkAbort(signal);

    if (!options.adapters.approve)
      throw failure("audit-required", "Exact artifact approval required");

    const decision = await abortable(
      options.adapters.approve(structuredClone(exact), signal),
      signal
    );

    if (decision.approved !== true || decision.identity !== exact.identity)
      throw failure("audit-required", "Exact artifact approval denied");
    checkAbort(signal);
  }

  async function beforeSelect(job: Job) {
    const signal = job.controller.signal;
    await approve(job.exact, signal);

    if (options.adapters.beforeSelect)
      await abortable(options.adapters.beforeSelect(structuredClone(job.exact), signal), signal);
    await approve(job.exact, signal);
    checkAbort(signal);
    emit(job, "activating");
    checkAbort(signal);
  }

  async function install(job: Job) {
    const { exact, controller } = job;
    const signal = controller.signal;
    const retained = await storage.current(exact.tool.id);
    job.progress = LanguageInstallProgress.make({
      ...job.progress,
      activeVersion: retained?.version ?? null,
    });
    emit(job, "preflight");
    await approve(exact, signal);

    if (retained?.identity === exact.identity) return retained;

    if (job.rollback) {
      await storage.load(exact.tool.id, exact.identity);
      await beforeSelect(job);

      return storage.select(exact.tool.id, exact.identity, signal);
    }

    emit(job, "downloading");
    let reportedAt = performance.now();

    const bytes = await collect(
      options.adapters.download(structuredClone(exact), signal),
      signal,
      limits,
      (size) => {
        const now = performance.now();

        if (now - reportedAt < 100) return;
        reportedAt = now;
        emit(job, "downloading", "", size);
      }
    );

    emit(job, "verifying", "", bytes.byteLength);

    if (!verifyIntegrity(bytes, exact.artifact.integrity))
      throw failure("audit-required", "Artifact integrity failed");

    checkAbort(signal);

    const payload = await abortable(
      options.adapters.decode(bytes, structuredClone(exact), signal),
      signal
    );

    const entries = verifyPayload(bytes, payload, exact, limits).map((entry) => ({
      ...entry,
      bytes: new Uint8Array(entry.bytes),
    }));

    checkAbort(signal);
    emit(job, "staging");

    return storage.stage(exact, entries, signal, () => beforeSelect(job));
  }

  async function run(job: Job, intent: InstallRequest["intent"]) {
    const timer = setTimeout(
      () => job.controller.abort(failure("timeout", "Installation deadline exceeded", true)),
      limits.timeoutMs
    );

    let release: (() => Promise<void>) | undefined;
    let result: InstalledVersion | undefined;
    let problem: LanguageError | undefined;

    try {
      checkAbort(job.controller.signal);
      release = await storage.lock(job.exact.tool.id);
      const retained = await storage.current(job.exact.tool.id);
      job.progress = LanguageInstallProgress.make({
        ...job.progress,
        activeVersion: retained?.version ?? null,
      });

      if (
        retained &&
        retained.identity !== job.exact.identity &&
        intent !== "update" &&
        !job.rollback
      )
        throw failure("conflict", "Version updates require an explicit update request", true);
      result = await install(job);
    } catch (error) {
      problem = normalizedError(error);

      if (!job.controller.signal.aborted) job.controller.abort(problem);
    } finally {
      clearTimeout(timer);

      if (release)
        await release().catch(() => {
          cleanupFailures.push(job.id);

          if (cleanupFailures.length > 64) cleanupFailures.shift();
        });

      if (options.adapters.afterSelection)
        await options.adapters.afterSelection(structuredClone(job.exact)).catch(() => {
          cleanupFailures.push(job.id);

          if (cleanupFailures.length > 64) cleanupFailures.shift();
        });
      jobs.delete(job.exact.tool.id);
    }

    if (result) {
      job.progress = LanguageInstallProgress.make({
        ...job.progress,
        activeVersion: result.version,
      });
      emit(job, "completed");

      for (const waiter of job.waiters) waiter.resolve(structuredClone(result));
    } else {
      const error = problem ?? failure("install-failed", "Installation failed", true);
      emit(
        job,
        error.reason === "cancelled" || error.reason === "timeout" ? "cancelled" : "failed",
        error.message
      );

      for (const waiter of job.waiters) waiter.reject(error);
    }

    waiterCount -= job.waiters.size;
    job.waiters.clear();
  }

  function attach(job: Job): InstallHandle {
    if (waiterCount >= limits.waiters)
      throw failure("queue-full", "Installer consumer limit reached", true);
    let waiter: Waiter;

    const result = new Promise<InstalledVersion>((resolve, reject) => {
      waiter = { resolve, reject };
    });

    // SAFETY: the Promise executor runs synchronously and initializes waiter before it is used.
    const consumer = waiter!;
    job.waiters.add(consumer);
    waiterCount++;

    return {
      jobId: job.id,
      result,
      cancel: () => {
        if (!job.waiters.delete(consumer)) return;
        waiterCount--;
        consumer.reject(failure("cancelled", "Installation consumer cancelled", true));

        if (job.waiters.size === 0) job.controller.abort();
      },
    };
  }

  function start(request: InstallRequest, rollback = false): InstallHandle {
    if (disposed) throw failure("cancelled", "Installer is disposed");
    let exact: ExactArtifact;

    try {
      exact = exactFor(request);
    } catch (cause) {
      if (Schema.is(LanguageError)(cause)) throw cause;
      throw failure("invalid-input", "Invalid catalog descriptor");
    }

    const existing = jobs.get(exact.tool.id);

    if (existing) {
      if (
        existing.exact.identity !== exact.identity ||
        existing.rollback !== rollback ||
        existing.controller.signal.aborted
      )
        throw failure("conflict", "Another version or operation is pending", true);

      return attach(existing);
    }

    if (jobs.size >= limits.jobs) throw failure("queue-full", "Installer job limit reached", true);
    const id = `install-${crypto.randomUUID()}`;

    const job: Job = {
      exact,
      id,
      controller: new AbortController(),
      waiters: new Set(),
      rollback,
      done: Promise.resolve(),
      progress: LanguageInstallProgress.make({
        hostId,
        toolId: exact.tool.id,
        version: exact.tool.version,
        jobId: id,
        sequence: 0,
        phase: "queued",
        downloadedBytes: 0,
        totalBytes: null,
        message: "",
        activeVersion: null,
      }),
    };

    const handle = attach(job);
    jobs.set(exact.tool.id, job);
    launches.set(exact.tool.id, (launches.get(exact.tool.id) ?? 0) + 1);
    job.done = Promise.resolve().then(() => run(job, request.intent));
    emit(job, "queued");

    return handle;
  }

  async function recoveryFacts(toolId: string) {
    const launched = launches.get(toolId);

    if (jobs.has(toolId)) return [];
    await options.adapters.beforeRecoveryScan?.(toolId);
    const facts = await storage.recoveryFacts(toolId);

    // A job launched during the scan owns the lock and stage the scan may have found.
    return jobs.has(toolId) || launches.get(toolId) !== launched ? [] : facts;
  }

  return {
    install: (request: InstallRequest) => start(request),
    rollback: (request: Omit<InstallRequest, "intent">) =>
      start({ ...request, intent: "update" }, true),
    current: (toolId: string) =>
      storage.current(toolId).catch((cause: unknown) => {
        throw Schema.is(LanguageError)(cause)
          ? cause
          : failure("install-failed", "Private installation could not be verified", true);
      }),
    versions: (toolId: string) =>
      storage.versions(toolId).catch((cause: unknown) => {
        throw Schema.is(LanguageError)(cause)
          ? cause
          : failure("install-failed", "Private installations could not be verified", true);
      }),
    recoveryFacts,
    progress: (toolId: string) => {
      const value = latest.get(toolId);

      return value ? structuredClone(value) : null;
    },
    subscribe(listener: (progress: Progress) => void) {
      if (disposed) throw failure("cancelled", "Installer is disposed");

      if (listeners.size >= limits.listeners)
        throw failure("queue-full", "Installer observer limit reached");
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    stats: () => ({
      verification: storage.stats(),
      jobs: jobs.size,
      waiters: waiterCount,
      listeners: listeners.size,
      retainedProgress: latest.size,
      cleanupFailures: [...cleanupFailures],
      disposed,
    }),
    async dispose() {
      disposed = true;
      listeners.clear();

      for (const job of jobs.values()) job.controller.abort();
      await Promise.all([...jobs.values()].map((job) => job.done));
      latest.clear();
    },
  };
}

export type Installer = Awaited<ReturnType<typeof createInstaller>>;

export type {
  InstallHandle,
  InstallRequest,
  InstallerOptions,
  InstalledVersion,
  ExactArtifact,
  InstallerAdapters,
  ApprovalDecision,
  ArtifactPayload,
  InstallLimits,
  Progress,
} from "./types.ts";

export { defaultLimits } from "./types.ts";
