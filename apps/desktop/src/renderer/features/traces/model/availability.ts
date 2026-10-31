/** Whether Traces (⌘5) can open on a Host: its Daemon must have the `traces` capability. */
import { TRACES_CAPABILITY } from "@polaris/protocol";
import type { HostView } from "../../../../shared/api.ts";
import { useApp } from "../../../shell/hooks.ts";

/** Why Traces can't open, or null. A Host that isn't connected hasn't said, so it isn't refused. */
export const tracesUnavailable = (
  host: Pick<HostView, "label" | "status"> | undefined
): string | null =>
  host === undefined ||
  host.status.state !== "connected" ||
  host.status.capabilities.includes(TRACES_CAPABILITY)
    ? null
    : `Traces need a newer daemon on ${host.label}`;

/** The selected Host's reason, live. */
export const useTracesUnavailable = (hostKey: string | null): string | null =>
  useApp((s) => tracesUnavailable(s.hosts.find((h) => h.key === hostKey)));
