/**
 * Traces settings in a preview, from `#traces/<scene>?settings=sightline&page=settings`: the
 * Workspace's detected exporters (sightline's three Axiom ones, or none), and Settings → Traces open.
 */
import {
  fixtureTracesSettingsApi,
  FRESH_SETTINGS,
  SIGHTLINE_SETTINGS,
} from "../settings/fixtures.ts";

const query = (hash: string) => new URLSearchParams(hash.split("?")[1] ?? "");

/** Every Workspace answers the scene's settings. */
export const previewSettingsApi = (hash: string) =>
  fixtureTracesSettingsApi(
    {},
    query(hash).get("settings") === "sightline" ? SIGHTLINE_SETTINGS : FRESH_SETTINGS
  );

export const opensSettings = (hash: string) => query(hash).get("page") === "settings";
