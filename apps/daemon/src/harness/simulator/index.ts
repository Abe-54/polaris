/**
 * The Simulator's MCP server for an Agent Session (`polaris_simulator`): agent-device behind
 * tools that run in the Daemon, so they mark the session's shown Simulator and publish
 * `AgentOpened` and `AgentDriving`. Claude Code and Codex sessions get it; read-only ones don't.
 */
import type { SessionId } from "@polaris/protocol";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, type Duration, Effect, Layer, Predicate, type Schema, Scope } from "effect";
import { type BunRuntime, SimulatorTools } from "../../install/simulator/index.ts";
import { HostPlatform } from "../../platform/index.ts";
import { SimulatorDetection, simulatorCapable } from "../../simulator/index.ts";
import type { SimulatorActivity } from "./activity.ts";
import { type AgentDeviceRun, androidEnv, liveAgentDevice } from "./agentDevice.ts";
import { sessionPath, simulatorMcpHttp } from "./http.ts";
import { failure, type SimulatorSession, simulatorSession } from "./session.ts";
import type { Platform } from "./platforms.ts";
import { possiblePlatforms, setupBlocker } from "./setup.ts";
import { SimulatorMcp } from "../../simulator/service.ts";
import { simulatorTools } from "./tools.ts";

export {
  SIMULATOR_MCP_NAME,
  SIMULATOR_TOOL_TIMEOUT_SECONDS,
  SimulatorMcp,
  type SimulatorMcpServer,
} from "../../simulator/service.ts";

const CLOSED = "This session's Simulator tools have closed.";

/** The most a session's open waits for the server; then it opens without one. */
const SETUP_TIMEOUT: Duration.Input = "10 seconds";

export interface SimulatorMcpOptions {
  readonly setupTimeout?: Duration.Input;
  /** How agent-device runs, given its installed script; tests pass a fake. */
  readonly agentDevice?: (
    script: string,
    cwd: string,
    env: Readonly<Record<string, string>>,
    bun: BunRuntime
  ) => AgentDeviceRun;
  readonly softWaitMs?: number | undefined;
}

interface Entry {
  readonly session: SimulatorSession;
  holders: number;
}

/** How `SimulatorMcp` is built; `transport/lazySimulator.ts` loads it on first use. */
export const SimulatorMcpLive = {
  /** `activityOf` gives the hub's session marks: `SimulatorHub` in the Daemon (serve.ts). */
  layerWith: <R>(
    activityOf: Effect.Effect<SimulatorActivity, never, R>,
    options: SimulatorMcpOptions = {}
  ) =>
    Layer.effect(
      SimulatorMcp,
      Effect.gen(function* () {
        const facts = yield* HostPlatform;

        if (!simulatorCapable(facts))
          return SimulatorMcp.of({ forSession: () => Effect.succeed(null) });
        const detection = yield* SimulatorDetection;
        const installs = yield* SimulatorTools;
        const activity = yield* activityOf;
        const layerScope = yield* Effect.scope;
        const byToken = new Map<string, Entry>();
        const runAgentDevice = options.agentDevice ?? liveAgentDevice;
        let scratch: string | null = null;

        /** The last detection, checked again while `platform` isn't Ready. */
        const reportFor = async (platform: Platform) => {
          const last = await Effect.runPromise(detection.current);

          return Predicate.isTagged(last.support[platform], "Ready")
            ? last
            : Effect.runPromise(detection.refresh);
        };

        const blocker = async (platform: Platform) =>
          setupBlocker(await reportFor(platform), platform);

        const platforms = async () => possiblePlatforms(await Effect.runPromise(detection.current));

        const agentDevice = async () => {
          const installed = await Effect.runPromise(
            installs.ensure.pipe(
              Effect.catchTag("SimulatorUnavailable", (error) =>
                Effect.die(new Error(error.message))
              )
            )
          );

          const { androidSdk } = await Effect.runPromise(detection.current);

          return runAgentDevice(
            installed.agentDevice,
            scratch ?? tmpdir(),
            androidEnv(androidSdk, process.env.PATH),
            installed.bun
          );
        };

        /** agent-device's daemon serves every session: stopped once none has used it. */
        const stopDaemon = async (ending: SimulatorSession) => {
          const run = await agentDevice().catch(() => null);

          if (run === null) return;
          await run(["close", "--session", ending.sessionName], { timeoutMs: 30_000 }).catch(
            () => {}
          );
          const othersUsed = [...byToken.values()].some((entry) => entry.session.used());

          if (!othersUsed) await run(["daemon", "stop"], { timeoutMs: 30_000 }).catch(() => {});
        };

        const listener = yield* Effect.cached(
          Effect.gen(function* () {
            scratch = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "polaris-simulator-")));
            yield* Effect.addFinalizer(() =>
              Effect.promise(() => rm(scratch ?? "", { recursive: true, force: true }))
            );

            return yield* simulatorMcpHttp(
              (token) => byToken.get(token)?.session ?? null,
              simulatorTools
            );
          }).pipe(Scope.provide(layerScope))
        );

        /** One token per session, shared by its concurrent opens. */
        const acquire = (sessionId: SessionId) =>
          Effect.sync(() => {
            for (const [token, entry] of byToken)
              if (entry.session.sessionId === sessionId) {
                entry.holders++;

                return token;
              }

            const token = randomBytes(32).toString("hex");

            const session = simulatorSession({
              sessionId,
              blocker,
              platforms,
              agentDevice,
              activity,
              scratch: scratch ?? tmpdir(),
              softWaitMs: options.softWaitMs,
            });

            byToken.set(token, { session, holders: 1 });

            return token;
          });

        const release = (token: string) =>
          Effect.promise(async () => {
            const entry = byToken.get(token);

            if (entry === undefined) return;
            entry.holders--;

            if (entry.holders > 0) return;
            byToken.delete(token);

            if (entry.session.used()) await stopDaemon(entry.session);
          });

        return SimulatorMcp.of({
          forSession: (sessionId) =>
            Effect.gen(function* () {
              const { origin } = yield* listener;
              const token = yield* Effect.acquireRelease(acquire(sessionId), release);

              const call = (name: string, input: typeof Schema.Json.Type) => {
                const session = byToken.get(token)?.session;
                const tool = simulatorTools.find((item) => item.name === name);

                if (session === undefined) return Promise.resolve(failure(CLOSED));

                return tool === undefined
                  ? Promise.resolve(failure(`No tool named ${name}`))
                  : tool.call(session, input);
              };

              return { url: `${origin}${sessionPath(token)}`, tools: simulatorTools, call };
            }).pipe(
              Effect.timeoutOrElse({
                duration: options.setupTimeout ?? SETUP_TIMEOUT,
                orElse: () =>
                  Effect.fail(new Error("setting up the Simulator tools took too long; skipped")),
              }),
              Effect.catchCause((cause) =>
                Effect.as(
                  Effect.logWarning(
                    `session ${sessionId}: no Simulator tools: ${String(Cause.squash(cause))}`
                  ),
                  null
                )
              ),
              Effect.withSpan("SimulatorMcp.forSession")
            ),
        });
      })
    ),
};
