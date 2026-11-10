/** The Simulator's hub and `polaris_simulator` over it; `lazySimulator.ts` loads this on first use. */
import { Effect, Layer } from "effect";
import { SimulatorMcpLive } from "../harness/simulator/index.ts";
import { HostPlatform } from "../platform/index.ts";
import { SimulatorHub, SimulatorHubLive } from "../simulator/hub.ts";

export const simulatorLive = SimulatorMcpLive.layerWith(
  Effect.gen(function* () {
    return yield* SimulatorHub;
  })
).pipe(Layer.provideMerge(SimulatorHubLive.layer), Layer.provide(HostPlatform.live));
