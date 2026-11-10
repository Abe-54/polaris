/**
 * Handlers the transport owns (`hello`) and placeholders for every other RPC,
 * so a Daemon is runnable end to end before the store, files, git and terminal
 * modules land. `server.ts` layers real handlers over these.
 *
 * One layer per RPC group: a single `toLayer` over all of `DaemonRpcs` passes
 * TypeScript's instantiation depth (TS2589, ENG-719).
 */
import { Layer } from "effect";
import { computerUseDefaults } from "./computerUse.ts";
import { coreDefaults } from "./core.ts";
import { featureDefaults } from "./features.ts";
import { hostDefaults } from "./host.ts";
import { requestDefaults } from "./requests.ts";
import type { DefaultOptions } from "./shared.ts";
import { workspaceDefaults } from "./workspace.ts";

export const defaultHandlers = (options: DefaultOptions) =>
  Layer.mergeAll(
    coreDefaults(options),
    hostDefaults(options),
    workspaceDefaults,
    featureDefaults,
    requestDefaults,
    computerUseDefaults
  );
