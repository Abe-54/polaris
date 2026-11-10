import { ComputerUseRpcs, Unsupported } from "@polaris/protocol";
import { Effect, Stream } from "effect";

const request = () => Effect.fail(new Unsupported({ capability: "computer-use" }));

/**
 * Computer use (ENG-846) where no real handler serves it: `Unsupported`, in a layer of its own
 * (`COMPUTER_USE_RPC_TAGS`). `computerUse/` serves the status, setup, on/off and allowed list.
 */
export const computerUseDefaults = ComputerUseRpcs.toLayer({
  "computerUse.status": request,
  "computerUse.watch": () => Stream.fail(new Unsupported({ capability: "computer-use" })),
  "computerUse.enable": request,
  "computerUse.disable": request,
  "computerUse.openSetup": request,
  "computerUse.allowedApps": request,
  "computerUse.removeAllowedApp": request,
  "computerUse.app": request,
  "computerUse.preview.watch": () =>
    Stream.fail(new Unsupported({ capability: "computer-use.preview" })),
  "computerUse.preview.latest": request,
});
