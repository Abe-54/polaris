import {
  AddAllowedApp,
  DisableComputerUse,
  EnableComputerUse,
  GetComputerUse,
  ListAllowedApps,
  OpenComputerUseSetup,
  RemoveAllowedApp,
  WatchComputerUse,
} from "@polaris/protocol";
import { Effect } from "effect";
import { RpcGroup } from "effect/rpc";
import { ComputerUseHost } from "./host.ts";

/** The Host's status, setup, on/off and allowed list (list, remove, add); `app` and the preview are served elsewhere. */
export const ComputerUseHostRpcs = RpcGroup.make(
  GetComputerUse,
  WatchComputerUse,
  EnableComputerUse,
  DisableComputerUse,
  OpenComputerUseSetup,
  ListAllowedApps,
  RemoveAllowedApp,
  AddAllowedApp
);

export const ComputerUseHostRpcHandlers = ComputerUseHostRpcs.toLayer(
  Effect.gen(function* () {
    const host = yield* ComputerUseHost;

    return {
      "computerUse.status": ({ refresh }) => (refresh ? host.ensure : host.current),
      "computerUse.watch": () => host.feed,
      "computerUse.enable": () => host.enable,
      "computerUse.disable": () => host.disable,
      "computerUse.openSetup": ({ permission }) => host.openSetup(permission),
      "computerUse.allowedApps": () => host.allowedApps,
      "computerUse.removeAllowedApp": ({ appId }) => host.removeAllowedApp(appId),
      "computerUse.allowedApps.add": ({ appId }) => host.addAllowedApp(appId),
    };
  })
);
