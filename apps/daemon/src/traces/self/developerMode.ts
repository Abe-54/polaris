/** Developer Mode fixed off: wiring that has no live Developer Mode Layer never traces. */
import { DEFAULT_DEVELOPER_MODE } from "@polaris/protocol";
import { Effect, Layer, Stream } from "effect";
import { DeveloperModeState } from "../../developerMode/service.ts";

export const developerModeOff = Layer.succeed(
  DeveloperModeState,
  DeveloperModeState.of({
    current: Effect.succeed(DEFAULT_DEVELOPER_MODE),
    changes: Stream.concat(Stream.succeed(DEFAULT_DEVELOPER_MODE), Stream.never),
  })
);
