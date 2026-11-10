import { afterEach, describe, expect, test } from "bun:test";
import { SessionId, SimulatorSessionItem, SimulatorSupport } from "@polaris/protocol";
import { Effect, Fiber, Layer, ManagedRuntime, Stream } from "effect";
import { SimulatorTools } from "../../install/simulator/index.ts";
import { HostPlatform } from "../../platform/index.ts";
import { SimulatorHub } from "../../simulator/hub.ts";
import { fakeHost, OURS, until } from "../../simulator/hub.testing.ts";
import { SimulatorDetection } from "../../simulator/index.ts";
import { SimulatorMcp, SimulatorMcpLive } from "./index.ts";
import { callTool } from "./mcp.testing.ts";

const SESSION = SessionId.make("feed-session");

const report = {
  support: {
    ios: SimulatorSupport.cases.Ready.make({}),
    android: SimulatorSupport.cases.Unsupported.make({}),
  },
  iosBlocked: null,
  androidSdk: null,
};

const runtimes: Array<ManagedRuntime.ManagedRuntime<SimulatorMcp | SimulatorHub, never>> = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

describe("the Simulator tools on the Daemon's hub", () => {
  test("an agent's open and its driving reach the session's feed", async () => {
    const hub = fakeHost().layer();

    const mcp = SimulatorMcpLive.layerWith(
      Effect.gen(function* () {
        return yield* SimulatorHub;
      }),
      {
        agentDevice: () => async (args) => ({
          exitCode: 0,
          stdout: JSON.stringify({ success: true, data: { device: args[0] } }),
          stderr: "",
        }),
      }
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          HostPlatform.test({ os: "darwin", arch: "arm64", libc: "none" }),
          Layer.succeed(SimulatorDetection)(
            SimulatorDetection.of({
              current: Effect.succeed(report),
              refresh: Effect.succeed(report),
              changes: Stream.never,
            })
          ),
          Layer.succeed(SimulatorTools)(
            SimulatorTools.of({
              current: Effect.die("unused"),
              ensure: Effect.succeed({ dir: "/t", hub: "/t/hub", agentDevice: "/t/ad.mjs" }),
            })
          )
        )
      ),
      Layer.provideMerge(hub)
    );

    const runtime = ManagedRuntime.make(mcp);
    runtimes.push(runtime);

    const items = await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const simulatorHub = yield* SimulatorHub;
          const server = yield* (yield* SimulatorMcp).forSession(SESSION);
          const seen: Array<SimulatorSessionItem> = [];

          const fiber = yield* simulatorHub.sessionFeed(SESSION).pipe(
            Stream.runForEach((item) => Effect.sync(() => seen.push(item))),
            Effect.forkScoped
          );

          yield* Effect.promise(() => until(() => seen.length === 1));
          yield* Effect.promise(() => callTool(server!.url, "simulator_open", { id: OURS }));
          yield* Effect.promise(() => until(() => seen.length === 5));
          yield* Fiber.interrupt(fiber);

          return seen;
        })
      )
    );

    const { Showing, AgentOpened, AgentDriving } = SimulatorSessionItem.cases;

    expect(items).toEqual([
      Showing.make({ id: null }),
      AgentDriving.make({ active: true }),
      Showing.make({ id: OURS }),
      AgentOpened.make({ id: OURS }),
      AgentDriving.make({ active: false }),
    ]);
  });
});
