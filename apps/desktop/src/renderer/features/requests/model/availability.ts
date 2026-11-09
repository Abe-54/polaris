/** Whether Requests (⌘6) can work on a Host: its Daemon must announce `requests`. */
import { REQUESTS_CAPABILITY } from "@polaris/protocol";
import type { HostView } from "../../../../shared/api.ts";
import { useApp } from "../../../shell/hooks.ts";

type HostFacts = Pick<HostView, "label" | "status"> | undefined;

/** Why Requests can't work, or null; a Host that isn't connected hasn't said, so isn't refused. */
export const requestsUnavailable = (host: HostFacts): string | null =>
  host !== undefined &&
  host.status.state === "connected" &&
  !host.status.capabilities.includes(REQUESTS_CAPABILITY)
    ? `Requests need a newer daemon on ${host.label}`
    : null;

export const useRequestsUnavailable = (hostKey: string | null): string | null =>
  useApp((s) => requestsUnavailable(s.hosts.find((h) => h.key === hostKey)));
