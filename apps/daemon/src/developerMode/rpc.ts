import { DeveloperModeRpcs } from "@polaris/protocol";
import { Effect, Stream } from "effect";
import { DeveloperModeControl } from "./live.ts";

/** `developerMode.*` (capability `developer-mode`); a lease lasts as long as its stream. */
export const DeveloperModeRpcHandlers = DeveloperModeRpcs.toLayer(
  Effect.gen(function* () {
    const control = yield* DeveloperModeControl;

    return {
      "developerMode.get": () => control.current,
      "developerMode.set": ({ enabled }) => control.setStored(enabled),
      "developerMode.setWorkspace": ({ workspaceId }) => control.setWorkspace(workspaceId),
      "developerMode.lease": () => Stream.unwrap(Effect.as(control.lease, control.changes)),
      "developerMode.watch": () => control.changes,
    };
  })
);
