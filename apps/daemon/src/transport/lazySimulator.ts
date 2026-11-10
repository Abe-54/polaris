import { SimulatorRpcs } from "@polaris/protocol";
import { Context, Effect, Layer, Stream } from "effect";
import { hostPlatform } from "../platform/index.ts";
import { SimulatorHub, SimulatorMcp, simulatorCapable } from "../simulator/service.ts";
import type { EventStore } from "../store/EventStore.ts";
import { cacheDaemonBuild } from "./lazy.ts";

/**
 * The Simulator's hub and MCP server (ENG-829), loaded on the first `simulator.*` RPC, agent
 * tool or session open on a Host that can run Simulators: a Daemon that never uses them loads none.
 */
export const lazySimulator = Layer.fromBuild((memoMap, scope) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<EventStore>();

    const load = yield* cacheDaemonBuild(
      Effect.gen(function* () {
        const module = yield* Effect.promise(() => import("./simulatorLive.ts"));

        const built = yield* Layer.buildWithMemoMap(module.simulatorLive, memoMap, scope).pipe(
          Effect.provide(context),
          Effect.orDie
        );

        return { hub: Context.get(built, SimulatorHub), mcp: Context.get(built, SimulatorMcp) };
      })
    );

    const hub = Effect.map(load, (loaded) => loaded.hub);

    const mcp = simulatorCapable(hostPlatform())
      ? SimulatorMcp.of({
          forSession: (sessionId) =>
            Effect.flatMap(load, (loaded) => loaded.mcp.forSession(sessionId)),
        })
      : SimulatorMcp.of({ forSession: () => Effect.succeed(null) });

    return Context.make(
      SimulatorHub,
      SimulatorHub.of({
        watch: Stream.unwrap(Effect.map(hub, (loaded) => loaded.watch)),
        boot: (id) => Effect.flatMap(hub, (loaded) => loaded.boot(id)),
        shutdown: (id, force) => Effect.flatMap(hub, (loaded) => loaded.shutdown(id, force)),
        restart: Effect.flatMap(hub, (loaded) => loaded.restart),
        attach: (sessionId, id) =>
          Stream.unwrap(Effect.map(hub, (loaded) => loaded.attach(sessionId, id))),
        sessionFeed: (sessionId) =>
          Stream.unwrap(Effect.map(hub, (loaded) => loaded.sessionFeed(sessionId))),
        agentOpened: (sessionId, id) =>
          Effect.flatMap(hub, (loaded) => loaded.agentOpened(sessionId, id)),
        agentDriving: (sessionId) =>
          Effect.flatMap(hub, (loaded) => loaded.agentDriving(sessionId)),
        shown: (sessionId) => Effect.flatMap(hub, (loaded) => loaded.shown(sessionId)),
        agentBooted: (id) => Effect.flatMap(hub, (loaded) => loaded.agentBooted(id)),
      })
    ).pipe(Context.add(SimulatorMcp, mcp));
  })
);

/** The `simulator.*` RPCs over `SimulatorHub`; `defaults/features.ts` answers them elsewhere. */
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
