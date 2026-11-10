/**
 * macOS setup: the helper app's two grants, read from agent-desktop's `status` run inside the
 * helper (preflight only, so it never prompts), and the Settings pane the user drags it into.
 */
import { basename } from "node:path";
import { type ComputerUsePermission, ComputerUseSetup } from "@polaris/protocol";
import type { ComputerUsePermissions } from "../service/computerUse/index.ts";
import type { HostProbe } from "./probe.ts";

/** Null when both grants are held; a helper that can't answer is missing both. */
export const macSetup = (permissions: ComputerUsePermissions | null): ComputerUseSetup | null => {
  const missing = permissions?.missing ?? ["accessibility", "screen recording"];

  return missing.length === 0
    ? null
    : ComputerUseSetup.cases.MacPermissions.make({
        accessibility: !missing.includes("accessibility"),
        screenRecording: !missing.includes("screen recording"),
      });
};

const PRIVACY = "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension";

/**
 * The pane for a permission. Accessibility is Device Control and Data Access on macOS 27,
 * the one step for both grants, so `null` opens it too.
 */
export const settingsUrl = (permission: ComputerUsePermission | null): string =>
  permission === "screen-recording"
    ? `${PRIVACY}?Privacy_ScreenCapture`
    : `${PRIVACY}?Privacy_Accessibility`;

/** Reveals the helper in Finder, then opens the pane in front of it to drag the helper into. */
export const openSetupCommands = (
  permission: ComputerUsePermission | null,
  helper: string
): ReadonlyArray<ReadonlyArray<string>> => [
  ["open", "-R", helper],
  ["open", settingsUrl(permission)],
];

/** A bundle id as Spotlight's query takes it: nothing that could end the quoted value. */
const BUNDLE_ID = /^[A-Za-z0-9._-]+$/;

/**
 * An installed app's name from its bundle id, as Spotlight knows it (`mdfind`); the id itself
 * off macOS, for an id that isn't a bundle id, and when Spotlight finds no such app.
 */
export const appName = async (probe: HostProbe, appId: string): Promise<string> => {
  if (probe.platform !== "darwin" || !BUNDLE_ID.test(appId)) return appId;

  const found = await probe.run(["mdfind", `kMDItemCFBundleIdentifier == '${appId}'`]);

  const path =
    found.code === 0 ? found.stdout.split("\n").find((line) => line.endsWith(".app")) : undefined;

  return path === undefined ? appId : basename(path, ".app");
};
