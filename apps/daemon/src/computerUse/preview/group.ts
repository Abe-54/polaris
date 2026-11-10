/**
 * The preview's two RPCs as a group of their own and its capability: all the transport loads
 * at startup. The handlers load with the first call (`transport/lazyComputerUse.ts`).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Capability, LatestPreview, WatchPreview } from "@polaris/protocol";
import { RpcGroup } from "effect/rpc";
import {
  COMPUTER_USE_CAPTURE,
  HELPER_FILES,
  helperBeside,
} from "../../service/computerUse/bundle.ts";

export const PREVIEW_CAPABILITY: Capability = "computer-use.preview";

export const PreviewRpcs = RpcGroup.make(WatchPreview, LatestPreview);

/** Whether the helper beside the Daemon at `daemonExecutable` holds the capture tool. */
export const hasCaptureTool = (daemonExecutable: string): boolean => {
  const helper = helperBeside(daemonExecutable);

  return helper !== null && existsSync(join(helper, HELPER_FILES[COMPUTER_USE_CAPTURE]));
};

/** This Host captures a window live: macOS, with the capture tool in the Daemon's helper app. */
export const livePreview = (
  platform: NodeJS.Platform = process.platform,
  daemonExecutable: string = process.execPath
): boolean => platform === "darwin" && hasCaptureTool(daemonExecutable);
