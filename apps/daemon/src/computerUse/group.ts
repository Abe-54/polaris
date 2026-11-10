/**
 * The Host's computer use RPCs as a group of their own: all the transport loads at startup. The
 * handlers (`rpc.ts`) load with the first call (`transport/lazyComputerUse.ts`).
 */
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
import { RpcGroup } from "effect/rpc";

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
