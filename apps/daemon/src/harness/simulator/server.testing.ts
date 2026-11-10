/** A `SimulatorMcp` over fake detection, installs and agent-device, for tests. */
import { type HostSimulatorSupport, SessionId, SimulatorSupport } from "@polaris/protocol";
import { Effect, Exit, Layer, ManagedRuntime, type Schema, Scope, Stream } from "effect";
import { SimulatorTools } from "../../install/simulator/index.ts";
import { HostPlatform, type PlatformFacts } from "../../platform/index.ts";
import { SimulatorDetection } from "../../simulator/index.ts";
import type { SimulatorActivity } from "./activity.ts";
import type { AgentDeviceRun, RunResult } from "./agentDevice.ts";
import { SimulatorMcp, SimulatorMcpLive } from "./index.ts";

export const S1 = SessionId.make("s1");

export const UDID = "11111111-2222-3333-4444-555555555555";

export const READY: HostSimulatorSupport = {
  ios: SimulatorSupport.cases.Ready.make({}),
  android: SimulatorSupport.cases.Unsupported.make({}),
};

export const ok = (data: typeof Schema.Json.Type): RunResult => ({
  exitCode: 0,
  stdout: JSON.stringify({ success: true, data }),
  stderr: "",
});

export type Answer = (args: ReadonlyArray<string>) => RunResult | Promise<RunResult>;

export const defaultAnswer: Answer = (args) =>
  args[0] === "open"
    ? ok({ device: "iPhone 17", selection: { bootOccurred: true } })
    : { exitCode: 0, stdout: `ran ${args[0]}`, stderr: "" };

export const runtimes: Array<ManagedRuntime.ManagedRuntime<SimulatorMcp, never>> = [];

/** Disposes every runtime `setup` made; call it from `afterEach`. */
export const disposeAll = async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
};

export const setup = (
  options: {
    readonly support?: HostSimulatorSupport;
    readonly iosBlocked?: string | null;
    readonly facts?: Partial<PlatformFacts>;
    readonly androidSdk?: string | null;
    readonly answer?: Answer;
    readonly softWaitMs?: number;
  } = {}
) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const marks: string[] = [];
  const answer = options.answer ?? defaultAnswer;

  const run: AgentDeviceRun = async (args) => {
    calls.push(args);
    marks.push(`run ${args[0]}`);

    return answer(args);
  };

  const activity: SimulatorActivity = {
    agentOpened: (sessionId, id) => Effect.sync(() => void marks.push(`opened ${sessionId} ${id}`)),
    agentDriving: (sessionId) =>
      Effect.acquireRelease(
        Effect.sync(() => void marks.push(`driving ${sessionId}`)),
        () => Effect.sync(() => void marks.push(`idle ${sessionId}`))
      ),
    shown: () => Effect.succeed(null),
    agentBooted: (id) => Effect.sync(() => void marks.push(`booted ${id}`)),
  };

  const report = {
    support: options.support ?? READY,
    iosBlocked: options.iosBlocked ?? null,
    androidSdk: options.androidSdk ?? null,
  };

  const envs: Array<Readonly<Record<string, string>>> = [];

  const layer = SimulatorMcpLive.layerWith(Effect.succeed(activity), {
    agentDevice: (_script, _cwd, env) => {
      envs.push(env);

      return run;
    },
    softWaitMs: options.softWaitMs,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        HostPlatform.test({ os: "darwin", arch: "arm64", libc: "none", ...options.facts }),
        Layer.succeed(SimulatorDetection)(
          SimulatorDetection.of({
            current: Effect.succeed(report),
            refresh: Effect.succeed(report),
            changes: Stream.empty,
          })
        ),
        Layer.succeed(SimulatorTools)(
          SimulatorTools.of({
            current: Effect.die("unused"),
            ensure: Effect.succeed({ dir: "/t", hub: "/t/hub", agentDevice: "/t/ad.mjs" }),
          })
        )
      )
    )
  );

  const runtime = ManagedRuntime.make(layer);
  runtimes.push(runtime);

  const open = async (sessionId = S1) => {
    const scope = Effect.runSync(Scope.make());

    const server = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SimulatorMcp).forSession(sessionId);
      }).pipe(Scope.provide(scope))
    );

    return { server, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
  };

  return { open, calls, marks, envs };
};
