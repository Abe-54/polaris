/**
 * The bridge the session feature talks through: `window.polaris`, unless the
 * fixture preview (`preview/`) has put a stand-in in its place.
 */
import type { PolarisApi } from "../../shared/api.ts";
import { traceRequests } from "./selfTraces/actions.ts";

let standIn: PolarisApi | null = null;

/** Its requests join the user action in progress, if any (selfTraces/actions.ts). */
export const polaris = (): PolarisApi => traceRequests(standIn ?? window.polaris);

/** Preview only: answer the feature's requests from fixtures. */
export const standInBridge = (api: PolarisApi | null) => {
  standIn = api;
};
