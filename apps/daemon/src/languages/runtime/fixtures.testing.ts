import { tempDir } from "../../platform/tempDir.testing.ts";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  HostId,
  LanguageFormatterSelection,
  LanguageDocumentNotification,
  LanguageCheckout,
  LanguageContextEvent,
  LanguageEffectiveSettings,
  LanguageError,
  WorkspaceId,
  WorktreeId,
} from "@polaris/protocol";
import type { LanguageContextIdentity } from "@polaris/protocol";
import { Predicate } from "effect";
import { createProjectDiscovery } from "../discovery/index.ts";
import { createLanguageBroker } from "./index.ts";
import { spawnLanguageProcess } from "./process.ts";

export async function fixture(
  mode = "ordinary",
  graceMs = 10,
  observeLifecycle?: Parameters<typeof createLanguageBroker>[0]["observeLifecycle"],
  discoveryGate?: Promise<void>,
  wrapProcess?: (
    port: ReturnType<typeof spawnLanguageProcess>
  ) => ReturnType<typeof spawnLanguageProcess>,
  treeEdits = false,
  lifecycleOptions: {
    providerId?: string;
    changeDebounceMs?: number;
    crashWindowMs?: number;
    reserveGate?: Promise<void>;
    processLimit?: number;
    failAdmissionOnce?: LanguageError;
    retirementDeadlineMs?: number;
    closeDeadlineMs?: number;
    connectionCloseDeadlineMs?: number;
  } = {}
) {
  const root = await realpath(tempDir("m31-t1-"));
  await writeFile(join(root, "file.ts"), "saved");

  const checkout = LanguageCheckout.cases.Workspace.make({
    workspaceId: WorkspaceId.make("workspace"),
    path: root,
  });

  const worktreeRoot = join(root, "worktree");
  await mkdir(worktreeRoot);
  await writeFile(join(worktreeRoot, "file.ts"), "saved worktree");

  const worktree = LanguageCheckout.cases.Worktree.make({
    workspaceId: checkout.workspaceId,
    worktreeId: WorktreeId.make("worktree"),
    path: worktreeRoot,
  });

  const registry = async (input: LanguageCheckout) => ({
    checkout: Predicate.isTagged(input, "ReviewCheckout")
      ? input
      : Predicate.isTagged(input, "Worktree")
        ? worktree
        : checkout,
    workspacePath: root,
  });

  const discovery = createProjectDiscovery({ registry });

  let trusted = true;
  let admissionFailure = lifecycleOptions.failAdmissionOnce;
  const processes: ReturnType<typeof spawnLanguageProcess>[] = [];

  const broker = createLanguageBroker({
    hostId: HostId.make("host"),
    processLimit: lifecycleOptions.processLimit ?? 8,
    discover: async (input) => {
      await discoveryGate;

      return discovery.discover(input);
    },
    invalidateDiscovery: discovery.invalidate,
    requireTrust: async (input) => {
      if (!trusted)
        throw new LanguageError({
          reason: "awaiting-trust",
          message: "Fixture untrusted",
          retryable: false,
        });

      const canonical = (await registry(input)).checkout;

      return { checkout: canonical, root: canonical.path, workspaceRoot: root };
    },
    reserveLaunch: async (request) => {
      await lifecycleOptions.reserveGate;

      if (admissionFailure !== undefined) {
        const failure = admissionFailure;
        admissionFailure = undefined;
        throw failure;
      }

      return {
        selectionIdentity: "fake-fixture-selection",
        validate: async () => {
          if (request.signal.aborted || !request.isCurrent()) throw new Error("Stale fake launch");
        },
        assertCurrent: () => {
          if (request.signal.aborted || !request.isCurrent()) throw new Error("Stale fake launch");
        },
        release: async () => {},
      };
    },
    resolveLaunch: async (facts) => ({
      executable: process.execPath,
      args: [join(import.meta.dir, "fake-server.testing.ts"), mode],
      cwd: facts.projectRoot,
      environment: {},
    }),
    observeLifecycle,
    supportsTreeEdits: () => treeEdits,
    spawn: (launch) => {
      const port = spawnLanguageProcess(launch);
      processes.push(port);

      return wrapProcess?.(port) ?? port;
    },
    graceMs,
    retryMs: 10,
    changeDebounceMs: lifecycleOptions.changeDebounceMs,
    crashWindowMs: lifecycleOptions.crashWindowMs,
    retirementDeadlineMs: lifecycleOptions.retirementDeadlineMs,
    closeDeadlineMs: lifecycleOptions.closeDeadlineMs,
    connectionCloseDeadlineMs: lifecycleOptions.connectionCloseDeadlineMs,
  });

  const uri = pathToFileURL(join(root, "file.ts")).href;

  const settings = LanguageEffectiveSettings.make({
    settings: { serverSettings: { fake: { nested: { value: "configured" } } } },
    revision: 0,
    formatOnSave: true,
    formatter: LanguageFormatterSelection.cases.None.make({}),
    providers: [lifecycleOptions.providerId ?? "fake"],
    origins: {},
  });

  async function acquire(
    clientId = "one",
    contextId = clientId,
    providerId = lifecycleOptions.providerId ?? "fake"
  ) {
    return broker.acquire(clientId, {
      clientId,
      contextId,
      checkout,
      path: join(root, "file.ts"),
      providerId,
      settings,
      interestId: "file",
    });
  }

  async function open(clientId: string, context: LanguageContextIdentity, text = "draft") {
    return broker.sync(clientId, {
      context,
      sequence: 1,
      notification: LanguageDocumentNotification.cases.Open.make({
        uri,
        languageId: "typescript",
        version: 1,
        text,
      }),
    });
  }

  async function ready(clientId: string, context: LanguageContextIdentity) {
    // A wall-clock bound: spawning the fake server can take seconds on a loaded runner.
    for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
      const snapshot = broker.snapshot(clientId, context);

      if (Predicate.isTagged(snapshot.runtime, "Ready")) return snapshot;
      await Bun.sleep(5);
    }

    throw new Error("Fixture readiness deadline");
  }

  async function dispose() {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }

  return {
    broker,
    root,
    checkout,
    worktree,
    worktreeRoot,
    settings,
    uri,
    acquire,
    open,
    ready,
    dispose,
    processes,
    revoke: () => {
      trusted = false;
      broker.invalidateTrust(checkout);
    },
    grant: () => {
      trusted = true;
    },
    snapshotEvent: LanguageContextEvent.cases.Snapshot,
  };
}
