/**
 * Computer use over IPC (ENG-846): each forwards the Daemon RPC of the same name on that Host,
 * only when its Daemon announces `computer-use`; answers cross unchanged.
 */
import {
  OpenComputerUseSetup,
  RemoveAllowedApp,
  type AllowedApp,
  type ComputerUseItem,
  type ComputerUseStatus,
} from "@polaris/protocol";
import { Schema } from "effect";

const OnHost = { hostKey: Schema.String.check(Schema.isMinLength(1)) };

export const ComputerUseRequestInputs = {
  "computerUse.status": Schema.Struct({ ...OnHost, refresh: Schema.Boolean }),
  "computerUse.enable": Schema.Struct(OnHost),
  "computerUse.disable": Schema.Struct(OnHost),
  "computerUse.openSetup": Schema.Struct({
    ...OnHost,
    ...OpenComputerUseSetup.payloadSchema.fields,
  }),
  "computerUse.removeAllowedApp": Schema.Struct({
    ...OnHost,
    ...RemoveAllowedApp.payloadSchema.fields,
  }),
} as const;

export interface ComputerUseRequestOutputs {
  readonly "computerUse.status": ComputerUseStatus;
  readonly "computerUse.enable": ComputerUseStatus;
  readonly "computerUse.disable": ComputerUseStatus;
  readonly "computerUse.openSetup": ComputerUseStatus;
  readonly "computerUse.removeAllowedApp": ReadonlyArray<AllowedApp>;
}

export const ComputerUseSubscriptionInputs = {
  /** The Host feed: a status, the always-allowed and the controlled apps, then each on change. */
  "computerUse.watch": Schema.Struct(OnHost),
} as const;

export interface ComputerUseSubscriptionItems {
  readonly "computerUse.watch": ComputerUseItem;
}
