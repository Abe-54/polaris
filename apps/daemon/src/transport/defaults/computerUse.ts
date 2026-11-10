import { ComputerUseRpcs } from "@polaris/protocol";
import { unsupported, unsupportedFeed } from "./shared.ts";

const request = unsupported("computer-use");

/**
 * Computer use (ENG-846) where no real handler serves it: `Unsupported`, in a layer of its own
 * (`COMPUTER_USE_RPC_TAGS`). `computerUse/` serves the status, setup, on/off and allowed list.
 */
export const computerUseDefaults = ComputerUseRpcs.toLayer({
  "computerUse.status": request,
  "computerUse.watch": unsupportedFeed("computer-use"),
  "computerUse.enable": request,
  "computerUse.disable": request,
  "computerUse.openSetup": request,
  "computerUse.allowedApps": request,
  "computerUse.removeAllowedApp": request,
  "computerUse.allowedApps.add": request,
  "computerUse.app": request,
  "computerUse.preview.watch": unsupportedFeed("computer-use.preview"),
  "computerUse.preview.latest": request,
});
