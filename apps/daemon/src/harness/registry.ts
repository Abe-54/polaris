/**
 * The Harness drivers this Daemon runs. The Codex driver owns the Host's shared
 * `codex app-server`, and the OpenCode driver its `opencode serve`; neither
 * outlives this layer's scope.
 *
 * Each driver's module is loaded on first use (`probe`, `open`), not at start:
 * the Claude Agent SDK and the Codex protocol schemas would otherwise sit in
 * every idle Daemon's memory. `kind` and `capabilities` are known up front
 * (the engine reads them without opening anything), and Claude's terminal
 * follow-along comes from the hook receiver, which does not need the SDK.
 *
 * Under launchd / systemd a user's PATH often lacks nvm or Homebrew bins, so
 * `POLARIS_CODEX`, `POLARIS_CLAUDE`, `POLARIS_OPENCODE`, `POLARIS_GEMINI` and
 * `POLARIS_COPILOT` can point at the binaries explicitly.
 * Requires `PlanLimitReporter`, where the drivers report what their Harness exposes, and
 * `BrowserMcp`, which gives Claude Code and Codex sessions the Browser's MCP server.
 */
import type { HarnessKind, KnownHarnessKind } from "@polaris/protocol";
import { Effect, Layer, Scope } from "effect";
import { HarnessRegistry, ServiceError } from "../services.ts";
import { ACP_HARNESSES } from "./acp/harnesses.ts";
import { isBenchKind } from "./bench/kinds.ts";
import { ClaudeHookReceiver } from "./claude/hooks.ts";
import { type HarnessDriver, HarnessError } from "./HarnessDriver.ts";
import { PlanLimitReporter } from "./limits/PlanLimitReporter.ts";
import { BrowserMcp } from "./browser/index.ts";
import { findExecutable } from "../platform/executable.ts";

const binary = (env: string, name: string): string | null =>
  findExecutable(process.env[env] || name);

/** What each driver declares; checked against the loaded drivers in registry.test.ts. */
export const DRIVER_CAPABILITIES = {
  codex: {
    steer: true,
    steerAttachments: true,
    liveCoAttach: true,
    switchModel: true,
    stopBackground: true,
    compact: true,
  },
  claude: {
    steer: true,
    steerAttachments: true,
    liveCoAttach: false,
    switchModel: true,
    stopBackground: true,
    backgroundCommand: true,
    shellCommand: true,
    compact: true,
  },
  opencode: { steer: true, steerAttachments: true, liveCoAttach: true, switchModel: true },
  gemini: { steer: false, liveCoAttach: false, switchModel: true },
  copilot: { steer: false, liveCoAttach: false, switchModel: true },
  bench: { steer: true, steerAttachments: true, liveCoAttach: true, switchModel: true },
} as const satisfies Record<KnownHarnessKind | "bench", HarnessDriver["capabilities"]>;

/**
 * A driver that loads the real one the first time it is probed or opened.
 * `extra` carries members that must not wait for the load (Claude's follow-along).
 */
export const lazyDriver = (
  kind: HarnessKind,
  capabilities: HarnessDriver["capabilities"],
  load: Effect.Effect<HarnessDriver>,
  extra: Pick<HarnessDriver, "terminalFollow"> = {}
): Effect.Effect<HarnessDriver> =>
  Effect.map(Effect.cached(load), (loaded) => ({
    kind,
    capabilities,
    ...extra,
    probe: Effect.flatMap(loaded, (driver) => driver.probe),
    listModels: Effect.flatMap(
      loaded,
      (driver) =>
        driver.listModels ??
        Effect.fail(new HarnessError({ harness: kind, message: "it doesn't list its Models yet" }))
    ),
    listCommands: (cwd) =>
      Effect.flatMap(loaded, (driver) => driver.listCommands?.(cwd) ?? Effect.succeed([])),
    validatePermissionMode: (options) =>
      Effect.flatMap(loaded, (driver) => driver.validatePermissionMode?.(options) ?? Effect.void),
    open: (options) => Effect.flatMap(loaded, (driver) => driver.open(options)),
  }));

export interface RegistryOptions {
  /**
   * Benchmarks and the dev Desktop App: the scripted bench Harness stands in for
   * Claude Code and Codex (`bench/kinds.ts`); the others stay real. Defaults to
   * `POLARIS_BENCH_HARNESS=1`.
   */
  readonly bench?: boolean;
}

export const harnessRegistryLayer = (options: RegistryOptions = {}) =>
  Layer.effect(
    HarnessRegistry,
    Effect.gen(function* () {
      const hookReceiver = yield* ClaudeHookReceiver;
      const { report } = yield* PlanLimitReporter;
      const browser = yield* BrowserMcp;
      const planLimits = { report };
      // The app-server the Codex driver may start belongs to this layer, not to the first `open`.
      const scope = yield* Effect.scope;
      const codexPath = binary("POLARIS_CODEX", "codex");
      const bench = options.bench ?? process.env.POLARIS_BENCH_HARNESS === "1";

      const benchDriver = (kind: HarnessKind) =>
        lazyDriver(
          kind,
          DRIVER_CAPABILITIES.bench,
          Effect.promise(() => import("./bench/BenchDriver.ts")).pipe(
            Effect.map(({ makeBenchDriver }) => makeBenchDriver(kind))
          )
        );

      // Every driver is lazy, so building the real ones the bench replaces costs nothing.
      const real: ReadonlyArray<HarnessDriver> = [
        yield* lazyDriver(
          "codex",
          DRIVER_CAPABILITIES.codex,
          Effect.promise(() => import("./codex/CodexDriver.ts")).pipe(
            Effect.flatMap(({ makeCodexDriver }) =>
              makeCodexDriver({ codexPath, planLimits, browser })
            ),
            Scope.provide(scope)
          )
        ),
        yield* lazyDriver(
          "claude",
          DRIVER_CAPABILITIES.claude,
          Effect.promise(() => import("./claude/ClaudeDriver.ts")).pipe(
            Effect.map(({ makeClaudeDriver }) =>
              // Looked up per session, so a Claude Code installed after start is found.
              makeClaudeDriver({
                hookReceiver,
                claudePath: () => binary("POLARIS_CLAUDE", "claude"),
                planLimits,
                browser,
              })
            )
          ),
          // While In Terminal, Polaris follows the TUI through its HTTP hooks (hooks.ts).
          { terminalFollow: { events: hookReceiver.events, release: hookReceiver.release } }
        ),
        yield* lazyDriver(
          "opencode",
          DRIVER_CAPABILITIES.opencode,
          Effect.promise(() => import("./opencode/OpenCodeDriver.ts")).pipe(
            Effect.flatMap(({ makeOpenCodeDriver }) =>
              makeOpenCodeDriver({ opencodePath: () => binary("POLARIS_OPENCODE", "opencode") })
            ),
            Scope.provide(scope)
          )
        ),
        ...(yield* Effect.forEach(ACP_HARNESSES, (harness) =>
          lazyDriver(
            harness.kind,
            DRIVER_CAPABILITIES[harness.kind],
            Effect.promise(() => import("./acp/AcpDriver.ts")).pipe(
              Effect.flatMap(({ makeAcpDriver }) =>
                makeAcpDriver({
                  harness,
                  binaryPath: () => binary(harness.binaryEnv, harness.binary),
                })
              ),
              Scope.provide(scope)
            )
          )
        )),
      ];

      const drivers = bench
        ? yield* Effect.forEach(real, (driver) =>
            isBenchKind(driver.kind) ? benchDriver(driver.kind) : Effect.succeed(driver)
          )
        : real;

      const byKind = new Map<HarnessKind, HarnessDriver>(drivers.map((d) => [d.kind, d]));

      return HarnessRegistry.of({
        get: (kind) => {
          const driver = byKind.get(kind);

          return driver
            ? Effect.succeed(driver)
            : Effect.fail(new ServiceError({ service: "harness", message: `no ${kind} driver` }));
        },
        all: Effect.succeed(drivers),
      });
    })
  ).pipe(Layer.provide(ClaudeHookReceiver.layer));

export const HarnessRegistryLive = harnessRegistryLayer();
