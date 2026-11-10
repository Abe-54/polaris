import { Effect } from "effect";
import { ComputerUseHostRpcs } from "./group.ts";
import { ComputerUseHost } from "./host.ts";

export { ComputerUseHostRpcs } from "./group.ts";

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
