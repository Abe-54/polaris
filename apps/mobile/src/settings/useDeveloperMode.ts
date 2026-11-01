/**
 * Each connected Host's Developer Mode, read when its connection changes (ENG-709). The phone
 * never writes it: only the desktop app sets it, and Polaris Dev holds leases.
 */
import { DEVELOPER_MODE_CAPABILITY } from "@polaris/protocol";
import { useEffect, useRef, useState } from "react";
import type { FollowedHostState } from "../home/feed/useFollowedHosts.ts";
import type { HostDeveloperMode } from "./model.ts";

export const useDeveloperMode = (
  hosts: ReadonlyArray<FollowedHostState>
): ReadonlyArray<HostDeveloperMode> => {
  const [modes, setModes] = useState<Readonly<Record<string, HostDeveloperMode>>>({});

  const live = hosts.filter(
    (h) =>
      h.status.state === "connected" && h.status.capabilities.includes(DEVELOPER_MODE_CAPABILITY)
  );

  const latest = useRef(live);
  latest.current = live;
  // Asked again only when a connection changes, not on every feed update.
  const key = live.map((h) => `${h.connection.hostId}:${h.status.epoch}`).join(",");

  useEffect(() => {
    let current = true;

    for (const host of latest.current) {
      void host.connection
        .run((client) => client["developerMode.get"]({}))
        .then(({ stored, effective }) => {
          if (current) setModes((s) => ({ ...s, [host.connection.hostId]: { stored, effective } }));
        })
        .catch(() => undefined);
    }

    return () => {
      current = false;
    };
  }, [key]);

  return live.flatMap((h) => modes[h.connection.hostId] ?? []);
};
