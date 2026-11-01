import type { DeveloperMode } from "@polaris/protocol";
import { Context, type Effect, type Stream } from "effect";

/** This Host's Developer Mode, as the Daemon's own tracers read it (ENG-708). */
export class DeveloperModeState extends Context.Service<
  DeveloperModeState,
  {
    readonly current: Effect.Effect<DeveloperMode>;
    readonly changes: Stream.Stream<DeveloperMode>;
  }
>()("polaris/developerMode/DeveloperModeState") {}
