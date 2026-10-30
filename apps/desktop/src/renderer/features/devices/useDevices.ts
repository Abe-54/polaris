/**
 * Settings → Devices' data: each Host's Relay route and Linked Devices, asked when the page
 * opens and after each change it makes; a Host with presence also pushes its devices live.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HostView } from "../../../shared/api.ts";
import { polaris } from "../bridge.ts";
import { showRefusal } from "../session/dispatch.ts";
import type { LinkedDeviceView } from "../../../shared/linkedDevicesContract.ts";
import { CAPABILITY, type DeviceSummary, type HostRelay, PRESENCE_CAPABILITY } from "./model.ts";

const label = (host: HostView) => ({ key: host.key, label: host.label });

const relayOf = async (host: HostView): Promise<HostRelay> => {
  if (host.status.state !== "connected")
    return { ...label(host), kind: "offline", state: host.status.state };

  if (!host.status.capabilities.includes(CAPABILITY))
    return { ...label(host), kind: "unsupported" };

  const [route, devices] = await Promise.all([
    polaris().request("relayRoute.status", { hostKey: host.key }),
    polaris().request("devices.list", { hostKey: host.key }),
  ]);

  if (!route.ok) return { ...label(host), kind: "failed", message: route.error.message };

  if (!devices.ok) return { ...label(host), kind: "failed", message: devices.error.message };

  return { ...label(host), kind: "ready", route: route.value, devices: devices.value };
};

/** A Host's line before it answers. */
const pending = (host: HostView): HostRelay =>
  host.status.state === "connected"
    ? { ...label(host), kind: "loading" }
    : { ...label(host), kind: "offline", state: host.status.state };

/** Each Host's devices from `devices.watch`, while its feed runs, by host key. */
const useWatched = (hosts: ReadonlyArray<HostView>, roster: string) => {
  const [watched, setWatched] = useState<ReadonlyMap<string, ReadonlyArray<LinkedDeviceView>>>(
    () => new Map()
  );

  const latest = useRef(hosts);
  latest.current = hosts;

  useEffect(() => {
    const keys = latest.current
      .filter(
        (h) => h.status.state === "connected" && h.status.capabilities.includes(PRESENCE_CAPABILITY)
      )
      .map((h) => h.key);

    const set = (hostKey: string, devices: ReadonlyArray<LinkedDeviceView> | null) =>
      setWatched((current) => {
        const next = new Map(current);

        if (devices === null) next.delete(hostKey);
        else next.set(hostKey, devices);

        return next;
      });

    const stops = keys.map((hostKey) =>
      polaris().subscribe(
        "devices.watch",
        { hostKey },
        {
          items: (items) => {
            const last = items.at(-1);

            if (last !== undefined) set(hostKey, last);
          },
          end: () => set(hostKey, null),
        }
      )
    );

    return () => stops.forEach((stop) => stop());
  }, [roster]);

  return watched;
};

export const useDevices = (hosts: ReadonlyArray<HostView>) => {
  const [answered, setRelays] = useState<ReadonlyArray<HostRelay>>(() => hosts.map(pending));
  const [asked, setAsked] = useState(0);
  const latest = useRef(hosts);
  latest.current = hosts;
  // Hosts change identity on every feed item; reload only when who is connected changes.
  const roster = hosts.map((h) => `${h.key}:${h.label}:${h.status.state}`).join("|");
  const watched = useWatched(hosts, roster);

  const relays = useMemo(
    () =>
      answered.map((relay) => {
        const devices = watched.get(relay.key);

        return relay.kind === "ready" && devices !== undefined ? { ...relay, devices } : relay;
      }),
    [answered, watched]
  );

  useEffect(() => {
    let live = true;

    void Promise.all(latest.current.map(relayOf)).then((next) => {
      if (live) setRelays(next);
    });

    return () => {
      live = false;
    };
  }, [roster, asked]);

  const reload = useCallback(() => setAsked((n) => n + 1), []);

  /** Unlinks the device on every Host it is on; each refusal toasts. */
  const unlink = async (device: DeviceSummary) => {
    const results = await Promise.all(
      device.on.map(({ hostKey, id }) => polaris().request("devices.unlink", { hostKey, id }))
    );

    for (const result of results)
      if (!result.ok) showRefusal(`Couldn't unlink ${device.name}`, result.error);

    reload();
  };

  /** "Retry": shares the device with each Host it didn't reach. */
  const share = async (device: DeviceSummary) => {
    const results = await Promise.all(
      device.notShared.map(({ key }) =>
        polaris().request("devices.share", {
          hostKey: key,
          name: device.name,
          relayAddress: device.relayAddress,
          noiseKey: device.noiseKey,
        })
      )
    );

    for (const result of results)
      if (!result.ok) showRefusal(`Couldn't share ${device.name}`, result.error);

    reload();
  };

  return { relays, reload, unlink, share };
};
