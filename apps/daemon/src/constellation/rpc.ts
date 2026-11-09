import { ConstellationCommand, ConstellationRpcs } from "@polaris/protocol";
import { Context, Effect } from "effect";
import type { ConstellationBinding } from "../engine/constellation.inputs.ts";
import { getDefaults, setDefaults } from "./defaults.ts";
import { finding, refusal } from "./decision.ts";
import { Constellations } from "./service.ts";
import { ConstellationStatsService } from "./stats/index.ts";
import { observeWorkerHost } from "./recovery.ts";
import { EventStore } from "../store/EventStore.ts";
import { ConstellationRuntime } from "./runtime.ts";
import { startWorker } from "./startWorker.ts";
import { RemoteWorkers } from "./transfers/assignments.ts";

/** Only the authenticated transport sets this annotation. Unbound Desktop connections are the user. */
export class ConstellationCaller extends Context.Service<
  ConstellationCaller,
  ConstellationBinding
>()("polaris/daemon/constellation/Caller") {}

const caller = (annotations: Context.Context<never>): ConstellationBinding =>
  Context.getOrUndefined(annotations, ConstellationCaller) ?? { kind: "user" };

export const ConstellationRpcHandlers = ConstellationRpcs.toLayer(
  Effect.gen(function* () {
    const graphs = yield* Constellations;
    const stats = yield* ConstellationStatsService;
    const store = yield* EventStore;
    const runtime = yield* ConstellationRuntime;
    const workers = yield* RemoteWorkers;
    const C = ConstellationCommand.cases;

    return {
      "constellation.connection": ({ hostId, offline }, { client }) =>
        caller(client.annotations).kind === "user"
          ? observeWorkerHost(hostId, offline).pipe(
              Effect.catchTag("ServiceError", () =>
                Effect.fail(
                  refusal(undefined, [
                    finding(
                      "E-CONNECTION",
                      "Could not record the Host observation",
                      "Retry when the owning Host is available."
                    ),
                  ])
                )
              )
            )
          : Effect.fail(
              refusal(undefined, [
                finding(
                  "E-AUTHORITY",
                  "Only the authenticated Client observes Host Connection State",
                  "Use the Desktop App connection."
                ),
              ])
            ),
      "constellation.defaults.get": () =>
        getDefaults.pipe(Effect.map((settings) => ({ settings }))),
      "constellation.defaults.set": ({ settings }, { client }) =>
        caller(client.annotations).kind === "user"
          ? setDefaults(settings)
          : Effect.fail(
              refusal(undefined, [
                finding("E-AUTHORITY", "Only the user can change defaults", "Use Settings."),
              ])
            ),
      "constellation.plan": ({ commandId, ...payload }, { client }) =>
        graphs.command(caller(client.annotations), commandId, C.Plan.make(payload)),
      "constellation.dispatch": ({ commandId, ...payload }, { client }) =>
        graphs.command(caller(client.annotations), commandId, C.Dispatch.make(payload)),
      "constellation.review": ({ commandId, ...payload }, { client }) =>
        graphs.command(caller(client.annotations), commandId, C.Review.make(payload)),
      "constellation.answer": ({ commandId, ...payload }, { client }) =>
        graphs.command(caller(client.annotations), commandId, C.Answer.make(payload)),
      "constellation.message": ({ commandId, ...payload }, { client }) =>
        graphs.command(caller(client.annotations), commandId, C.Message.make(payload)),
      "constellation.set_state": ({ commandId, ...payload }, { client }) =>
        graphs.command(caller(client.annotations), commandId, C.SetState.make(payload)),
      "constellation.worker.block": ({ commandId, ...payload }, { client }) =>
        graphs.command(caller(client.annotations), commandId, C.WorkerBlock.make(payload)),
      "constellation.worker.claim": ({ commandId, ...payload }, { client }) =>
        graphs.command(caller(client.annotations), commandId, C.WorkerClaim.make(payload)),
      "constellation.worker.ask": ({ commandId, ...payload }, { client }) =>
        graphs.command(caller(client.annotations), commandId, C.WorkerAsk.make(payload)),
      "constellation.worker.progress": ({ commandId, ...payload }, { client }) =>
        graphs.command(caller(client.annotations), commandId, C.WorkerProgress.make(payload)),
      "constellation.worker.propose": ({ commandId, ...payload }, { client }) =>
        graphs.command(caller(client.annotations), commandId, C.WorkerPropose.make(payload)),
      "constellation.worker.message": ({ commandId, ...payload }, { client }) =>
        graphs.command(caller(client.annotations), commandId, C.WorkerMessage.make(payload)),
      "constellation.worker.start": ({ constellationId, attemptId }, { client }) =>
        startWorker(caller(client.annotations), constellationId, attemptId).pipe(
          Effect.provideService(EventStore, store),
          Effect.provideService(ConstellationRuntime, runtime),
          Effect.provideService(RemoteWorkers, workers)
        ),
      "constellation.status": ({ constellationId, json, since }, { client }) =>
        graphs.status(
          caller(client.annotations),
          constellationId,
          json === true,
          since === undefined ? {} : { since }
        ),
      "constellation.stats": ({ constellationId }, { client }) =>
        stats.get(caller(client.annotations), constellationId),
      "constellation.subscribe": ({ constellationId, afterSequence }, { client }) =>
        graphs.subscribe(caller(client.annotations), constellationId, afterSequence),
    };
  })
);
