import { PredictionCapabilityLive } from "../prediction/capability.ts";
import { PredictionServerLive } from "../prediction/server.ts";
/**
 * `polaris serve`: run the Daemon until SIGINT / SIGTERM.
 *
 * Handler layers from other Daemon modules are added to `daemonHandlers`
 * below as they land; `startServer` falls back to placeholders for the rest.
 */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { supportsTrash } from "../files/trash.ts";
import { type Capability, HARNESS_CATALOGUE } from "@polaris/protocol";
import { Deferred, Effect, Layer } from "effect";
import { AttachmentRpcsLive } from "../attachments/AttachmentRpcs.ts";
import { AttachmentStoreLive } from "../attachments/AttachmentStore.ts";
import { ConstellationLiveness } from "../constellation/liveness.ts";
import { ConstellationHarness } from "../constellation/composition/attachments.ts";
import { lazyConstellationHandlers, lazyHostResources } from "./lazy.ts";
import { installDebugHooks, reportStartupModules } from "../debug.ts";
import { Engine } from "../engine/Engine.ts";
import { EngineRpcHandlers } from "../engine/rpc.ts";
import { VisualsRpcHandlers } from "../visuals/index.ts";
import { RestartRpcHandlers } from "../engine/restartRpc.ts";
import { Continuity, ContinuityRpcsLive } from "../continuity/index.ts";
import { FileSearchLive } from "../files/FileSearch.ts";
import { PredictionRpcsLive } from "../prediction/index.ts";
import { InlineRpcsLive } from "../inline/index.ts";
import { CommitMessageRpcsLive } from "../commitMessage/index.ts";
import { FilesRpcsLive } from "../files/FilesRpcs.ts";
import { CheckpointsLive } from "../git/Checkpoints.ts";
import { GitRpcsLive } from "../git/GitRpcs.ts";
import { ReviewCheckoutGitLive } from "../git/ReviewCheckoutGit.ts";
import { ReviewReadRpcsLive } from "../review/ReviewRpcs.ts";
import { ReviewerPolicyLive } from "../reviewer/policy.ts";
import { ReviewerRpcsLive } from "../reviewer/ReviewerRpcs.ts";
import { ReviewerSessions } from "../reviewer/sessions.ts";
import { RulesLive } from "../rules/index.ts";
import { WorktreeTrackerLive } from "../git/WorktreeTracker.ts";
import { Availability, AvailabilityRpcsLive } from "../harness/availability/index.ts";
import { HarnessRpcsLive } from "../harness/HarnessRpcs.ts";
import { latestRolloutLimits, PlanLimitReporter } from "../harness/limits/index.ts";
import { HarnessRegistryLive } from "../harness/registry.ts";
import { BrowserMcp } from "../harness/browser/index.ts";
import { AgentBrowser } from "../install/agentBrowser/index.ts";
import { releaseMemory, releaseWhenQuiet } from "../memory/index.ts";
import { userPath } from "../service/userPath.ts";
import { takeHandoff } from "../service/upgrade.ts";
import { EventStore } from "../store/EventStore.ts";
import { TerminalRpcsLive } from "../terminal/TerminalRpcs.ts";
import { TerminalsDaemonLive } from "../terminal/Terminals.ts";
import { UsageRpcsLive } from "../usage/UsageRpcs.ts";
import { UsageSessions } from "../usage/sessions.ts";
import { DeepgramLive } from "../voice/deepgram.ts";
import { HostSecrets } from "../secrets/index.ts";
import { VoiceRpcsLive } from "../voice/VoiceRpcs.ts";
import { ResourceRpcsLive } from "../resources/rpc.ts";
import { HostStats, HostStatsRpcsLive } from "../hostStats/index.ts";
import { paths } from "../paths.ts";
import { startServer } from "./server.ts";
import { ByteStreamRpcsLive } from "./byteStreams.ts";
import {
  BrowserHosting,
  browserHostingSlot,
  ByteStreamQuota,
  CdpRelay,
  HostAddressStreams,
} from "../browser/index.ts";
import { configuredGatewayPort } from "../gateway/index.ts";
import { workspaceTrustLayer } from "./workspaceTrust.ts";
import {
  armShutdownDeadline,
  armShutdownGrace,
  deadline,
  exitStuck,
  STARTUP_DEADLINE_MS,
} from "./deadline.ts";
import { writeStopRecord } from "../service/daemonStop.ts";
import { VERSION } from "../service/platform.ts";
import { SERVE_EXIT_STOPPED } from "../service/windowsTask.ts";
import { lazyAcceptHandlers } from "./lazyAccept.ts";
import { languagesAvailable, lazyLanguageHandlers } from "./lazyLanguages.ts";
import { lazyReviewer } from "./lazyReviewer.ts";
import { lazyUsage } from "./lazyUsage.ts";
import { LiveNotifierLive } from "../push/liveNotifier.ts";
import { PushNotifierLive } from "../push/notifier.ts";

/** Exit status when another Daemon already holds the lock or answers on the socket. */
export const SERVE_EXIT_ALREADY_RUNNING = 75;

/** Benchmarks script their Harness, so they skip Codex's rollout logs. */
const bench = process.env.POLARIS_BENCH_HARNESS === "1";

/**
 * The Usage index and the Plan Limit sink the drivers report to, loaded on
 * first use; `usage.watch` seeds Codex's last Plan Limits from its rollout logs.
 */
const usageServices = lazyUsage(bench ? {} : { planLimitSeed: latestRolloutLimits() }).pipe(
  Layer.provide(UsageSessions.layer)
);

/** The relay sits under the Engine; the hosting it uses is built with the transport and bound below. */
const hostingSlot = browserHostingSlot();

/** The per-session CDP relay (ENG-616), over the Browser hosting the byte-stream handlers bind. */
const cdpRelay = Layer.suspend(() =>
  CdpRelay.layer({ home: paths().root, version: VERSION }).pipe(Layer.provide(hostingSlot.layer))
);

const browserMcp = BrowserMcp.layer.pipe(
  Layer.provide(Layer.mergeAll(cdpRelay, AgentBrowser.layer))
);

/** The drivers report Plan Limits through the reporter, in front of the Usage index's sink. */
const harnesses = HarnessRegistryLive.pipe(
  Layer.provide(Layer.mergeAll(PlanLimitReporter.layer, browserMcp))
);

/**
 * The services behind the handlers: the event store and engine, git,
 * attachments, Harnesses, Usage, terminals (the engine asks which are open in
 * a Review Checkout), the Rules and the Reviewer (whose sessions' approvals the
 * engine asks its policy about), and giving memory back once work settles.
 */
const engineServices = Layer.mergeAll(Engine.layer, releaseWhenQuiet()).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ConstellationHarness.layer,
      ConstellationLiveness.proxyLayer,
      lazyHostResources,
      harnesses,
      CheckpointsLive,
      WorktreeTrackerLive,
      ReviewCheckoutGitLive,
      Layer.suspend(() => workspaceTrustLayer(paths().root)),
      AttachmentStoreLive(),
      TerminalsDaemonLive,
      ReviewerPolicyLive,
      RulesLive,
      Availability.layer()
    )
  ),
  Layer.provideMerge(usageServices),
  Layer.provideMerge(ReviewerSessions.layer),
  Layer.provideMerge(EventStore.layerLive)
);

const daemonServices = lazyReviewer.pipe(Layer.provideMerge(engineServices));

/** Host-address and Browser streams (ENG-613); `HostPresence` comes from the transport. */
const byteStreamHandlers = Layer.merge(ByteStreamRpcsLive, hostingSlot.bind).pipe(
  Layer.provide(
    Layer.mergeAll(HostAddressStreams.layer, BrowserHosting.layerLive()).pipe(
      Layer.provideMerge(ByteStreamQuota.layer())
    )
  )
);

/** Every real handler layer the Daemon mounts. Compose new modules' layers here. */
export const daemonHandlers = Layer.mergeAll(
  PredictionCapabilityLive,
  PredictionServerLive,
  lazyLanguageHandlers,
  InlineRpcsLive,
  PredictionRpcsLive,
  CommitMessageRpcsLive,
  EngineRpcHandlers,
  VisualsRpcHandlers,
  RestartRpcHandlers,
  ContinuityRpcsLive.pipe(Layer.provide(Continuity.layer)),
  HostStatsRpcsLive.pipe(Layer.provide(HostStats.layer())),
  PushNotifierLive,
  LiveNotifierLive,
  ResourceRpcsLive,
  lazyConstellationHandlers,
  FilesRpcsLive.pipe(Layer.provide(FileSearchLive())),
  GitRpcsLive,
  AttachmentRpcsLive,
  HarnessRpcsLive,
  AvailabilityRpcsLive,
  UsageRpcsLive,
  ReviewReadRpcsLive,
  lazyAcceptHandlers,
  ReviewerRpcsLive,
  TerminalRpcsLive.pipe(Layer.provide(TerminalsDaemonLive)),
  VoiceRpcsLive.pipe(Layer.provide(Layer.merge(DeepgramLive, HostSecrets.layer))),
  byteStreamHandlers
).pipe(Layer.provide(daemonServices));

/** What the lazy language handlers serve: unavailable where no language artifact runs. */
const LANGUAGE_CAPABILITIES: ReadonlyArray<Capability> = [
  "prediction.context",
  "languages",
  "languages.trust",
  "languages.format",
  "languages.project-format",
  "languages.buffer-acknowledgments",
  "languages.edit-preparation",
  "languages.edits",
  "languages.resources",
  "languages.resources.tree-v2",
];

export const daemonCapabilities: ReadonlyArray<Capability> = [
  "prediction.capability",
  ...(languagesAvailable() ? LANGUAGE_CAPABILITIES : []),
  "inline.propose",
  "prediction.complete",
  "prediction.edit",
  "prediction.server",
  "prediction.managed",
  "commit.suggest-message",
  "approval.secret",
  "constellation",
  "constellation.defaults",
  "extensions",
  "remote-access",
  "host.restart",
  "linked-devices",
  "linked-devices.presence",
  "presence",
  "voice",
  ...HARNESS_CATALOGUE.map((harness) => harness.capability),
  "harness.availability",
  "harness.models",
  "harness.commands",
  "harness.spinner-verbs",
  "session.set-model",
  "session.service-tier",
  "session.steer",
  "session.steer-attachments",
  "session.fork",
  "session.terminal-handoff",
  "session.terminal-command",
  "workspace.setup",
  "session.live-items",
  "session.subagents",
  "session.background-tasks",
  "session.turn-paging",
  "session.stop-background",
  "session.background-command",
  "session.compaction",
  "session.notify",
  "session.pin",
  "session.limited",
  "session.plan-mode",
  "session.user-turns",
  "session.shell-command",
  "session.continuity",
  "files.read",
  "files.versioned",
  "files.write",
  "files.manage",
  "files.watch-file",
  ...(supportsTrash ? ["files.trash" as const] : []),
  "files.search",
  "files.watch",
  "git.diff",
  "git.diff-files",
  "git.diff-turns",
  "git.show",
  "git.write",
  "git.init",
  "git.watch",
  "git.sync",
  "git.log",
  "session.feedback",
  "session.accept",
  "review.checkouts",
  "review.risk-summary",
  "review.ask",
  "review.verdicts",
  "review.reviewer-settings",
  "review.walkthrough",
  "review.latest-summary",
  "session.accept-latest",
  "attachments.stage",
  "attachments.read",
  "attachments.settings",
  "sessions.auto-archive",
  "sessions.idle-compaction",
  "sessions.visuals",
  "terminal",
  "terminal.binary",
  "usage",
  "host.resources",
  "host.stats",
  "host-address",
  "browser.host",
];

/**
 * Resolves with the reason when this Daemon is asked to stop on its Windows
 * control pipe (`service/windowsControl.ts`); elsewhere a stop is a signal, so never.
 */
const stopRequests = Effect.gen(function* () {
  const stop = yield* Deferred.make<string>();

  if (process.platform !== "win32") return Deferred.await(stop);
  const { serveControl } = yield* Effect.promise(() => import("../service/windowsControl.ts"));

  yield* Effect.acquireRelease(
    Effect.sync(() =>
      serveControl(paths().root, VERSION, (reason) => {
        Deferred.doneUnsafe(stop, Effect.succeed(reason));
      })
    ),
    (control) => Effect.sync(() => control.stop())
  );

  return Deferred.await(stop);
});

export const serveProgram = Effect.scoped(
  Effect.gen(function* () {
    const startup = yield* Effect.acquireRelease(
      Effect.sync(() =>
        deadline("taking the upgrade hand-off", {
          ms: STARTUP_DEADLINE_MS,
          onExpire: exitStuck("startup"),
        })
      ),
      (armed) => Effect.sync(armed.clear)
    );

    yield* takeHandoff();

    // Adopt descriptors before the login-shell PATH probe or any handler starts a child.
    startup.phase("probing the login shell's PATH");

    if (!bench) process.env.PATH = userPath({ env: process.env });

    const server = yield* startServer({
      handlers: daemonHandlers,
      capabilities: daemonCapabilities,
      gateway: { port: yield* configuredGatewayPort(paths().config) },
      // Windows has no execve or SIGUSR2: an upgrade there stops and restarts the Daemon (ADR 0060).
      upgrades: process.platform !== "win32",
      onPhase: startup.phase,
    });

    startup.clear();

    // Return temporary startup allocations once every handler and listener is installed.
    yield* releaseMemory;

    reportStartupModules();

    yield* Effect.logInfo(`polaris Daemon listening on ${server.socketPath}`);

    if (server.gateway !== null)
      yield* Effect.logInfo(`the gateway listens on ${server.gateway.url}`);

    const reason = yield* yield* stopRequests;
    yield* Effect.sync(() => {
      armShutdownDeadline();

      if (reason !== "uninstall") writeStopRecord(paths().root, reason, VERSION);
    });
    yield* Effect.logInfo(`polaris Daemon stopping on request (${reason})`);
  })
).pipe(
  // A requested stop ends the scope gracefully; then nothing may keep the process alive.
  Effect.andThen(() => Effect.sync(() => process.exit(SERVE_EXIT_STOPPED))),
  Effect.catchTag("DaemonAlreadyRunning", (error) =>
    Effect.sync(() => {
      process.stderr.write(`polaris serve: ${error.message}\n`);
      process.exit(SERVE_EXIT_ALREADY_RUNNING);
    })
  )
);

export const runServe = () => {
  installDebugHooks();
  armShutdownGrace();
  BunRuntime.runMain(serveProgram);
};
