/**
 * Whether Traces (⌘5) can open on a Host, and whether it can show Profiles: its Daemon must have
 * the `traces` capability, and `traces.profiles` for Profiles.
 */
import { type Capability, TRACES_CAPABILITY, TRACES_PROFILES_CAPABILITY } from "@polaris/protocol";
import type { HostView } from "../../../../shared/api.ts";
import { useApp } from "../../../shell/hooks.ts";

type HostFacts = Pick<HostView, "label" | "status"> | undefined;

/** A Host that isn't connected hasn't said, so it isn't refused. */
const missing = (host: HostFacts, capability: Capability) =>
  host !== undefined &&
  host.status.state === "connected" &&
  !host.status.capabilities.includes(capability);

/** Why Traces can't open, or null. */
export const tracesUnavailable = (host: HostFacts): string | null =>
  missing(host, TRACES_CAPABILITY) ? `Traces need a newer daemon on ${host?.label}` : null;

/** Why Profiles can't be listed or recorded, or null. */
export const profilesUnavailable = (host: HostFacts): string | null =>
  missing(host, TRACES_PROFILES_CAPABILITY)
    ? `Profiles need a newer daemon on ${host?.label}`
    : null;

/** The selected Host's reason, live. */
export const useTracesUnavailable = (hostKey: string | null): string | null =>
  useApp((s) => tracesUnavailable(s.hosts.find((h) => h.key === hostKey)));

export const useProfilesUnavailable = (hostKey: string | null): string | null =>
  useApp((s) => profilesUnavailable(s.hosts.find((h) => h.key === hostKey)));
