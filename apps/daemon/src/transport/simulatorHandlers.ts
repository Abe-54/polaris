/** The `simulator.*` RPCs over `SimulatorHub` (ENG-829); `defaults/features.ts` answers them elsewhere. */
import { SimulatorRpcs } from "@polaris/protocol";
import { Effect } from "effect";
import { SimulatorHub } from "../simulator/service.ts";

export const SimulatorRpcHandlers = SimulatorRpcs.toLayer(
  Effect.gen(function* () {
    const hub = yield* SimulatorHub;

    return {
      "simulator.watch": () => hub.watch,
      "simulator.boot": ({ id }) => hub.boot(id),
      "simulator.shutdown": ({ id, force }) => hub.shutdown(id, force === true),
      "simulator.restart": () => hub.restart,
      "simulator.attach": ({ sessionId, id }) => hub.attach(sessionId, id),
      "simulator.sessionFeed": ({ sessionId }) => hub.sessionFeed(sessionId),
    };
  })
);
