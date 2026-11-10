/**
 * The Electron fuses every packaged Desktop App ships with (ENG-878): no Node mode, no
 * NODE_OPTIONS, no inspector flags, the app only from its checked `app.asar`, encrypted cookies.
 * Packaging flips them before the integrity digest and signing, then reads them back.
 */
import { join } from "node:path";
import {
  FuseState,
  FuseV1Options,
  FuseVersion,
  flipFuses,
  getCurrentFuseWire,
} from "@electron/fuses";
import type { FuseV1Config } from "@electron/fuses";
import type { HookFunction } from "@electron/packager";

type Platform = "darwin" | "linux" | "win32";

/** Every fuse Electron 44 has, so an upgrade that adds one fails packaging until it is decided. */
export const FUSES = {
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.WasmTrapHandlers]: true,
} as const satisfies Record<FuseV1Options, boolean>;

const FUSED: Record<Platform, string> = {
  darwin: "Polaris.app",
  linux: "polaris",
  win32: "Polaris.exe",
};

/** What @electron/fuses opens in a packaged app: the bundle on macOS, the executable elsewhere. */
export const fusedBinary = (dir: string, platform: Platform): string => join(dir, FUSED[platform]);

export const flipAppFuses = (binary: string): Promise<number> => {
  const config: FuseV1Config = {
    version: FuseVersion.V1,
    // Flipping invalidates the framework's ad-hoc signature, which Apple Silicon refuses.
    resetAdHocDarwinSignature: true,
    strictlyRequireAllFuses: true,
    ...FUSES,
  };

  return flipFuses(binary, config);
};

/** The fuses that differ from FUSES in a built app, as `name: found`; empty when all match. */
export const fuseMismatches = async (binary: string): Promise<string[]> => {
  const wire = await getCurrentFuseWire(binary);

  return Object.entries(FUSES).flatMap(([option, want]) => {
    // SAFETY: FUSES is keyed by FuseV1Options' numeric values, which Object.entries stringifies.
    const key = Number(option) as FuseV1Options;
    const found = wire[key];

    if (found === (want ? FuseState.ENABLE : FuseState.DISABLE)) return [];

    return [`${FuseV1Options[key]}: ${found === undefined ? "missing" : FuseState[found]}`];
  });
};

export const assertAppFuses = async (binary: string): Promise<void> => {
  const wrong = await fuseMismatches(binary);

  if (wrong.length > 0)
    throw new Error(`${binary} has unexpected Electron fuses: ${wrong.join(", ")}`);
};

/** Packager's `afterCopyExtraResources` hook: after renaming, before the digest and signing. */
export const fusesHook: HookFunction = async ({ buildPath, platform }) => {
  // SAFETY: package.ts only targets darwin, linux and win32 (targets.ts).
  await flipAppFuses(fusedBinary(buildPath, platform as Platform));
};
