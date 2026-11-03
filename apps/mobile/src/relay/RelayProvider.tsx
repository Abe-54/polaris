/**
 * The device's linked Hosts as React state: on start it reads the Keychain and connects
 * every linked Host through the Polaris Relay; `link` links this iPhone with a link
 * string and adds the Hosts it names. Sits inside the HostsProvider.
 */
import {
  checkLinkedHosts,
  type DeviceKeys,
  deviceKeys,
  linkedHosts,
  type LinkedHost,
  linkDevice,
  makeRelayDevice,
  type RelayDevice,
  readLink,
} from "@polaris/client/relay";
import { Effect } from "effect";
import { Platform } from "react-native";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type HostRegistry, useHostRegistry } from "../runtime/hosts.tsx";
import {
  forgetLink,
  keepHosts,
  loadHosts,
  loadSecrets,
  saveLink,
  secretsForLinking,
} from "./store.ts";
import { relayTransport } from "./transport.ts";
import { unlinkFrom } from "./unlink.ts";

/** Shown to the Host in its Linked Devices; iOS gives apps no user-set device name. */
const DEVICE_NAME = Platform.OS === "android" ? "Android" : "iPhone";

/** Every Host the link named, the linking one first; or the screen's copy for why not. */
export type LinkOutcome =
  | { readonly linked: true; readonly hosts: ReadonlyArray<LinkedHost> }
  | { readonly linked: false; readonly message: string };

export interface Relay {
  /** False until the Keychain was read. */
  readonly loaded: boolean;
  /** This device's relay identity and address; null before its first link. */
  readonly keys: DeviceKeys | null;
  readonly hosts: ReadonlyArray<LinkedHost>;
  readonly routeOf: (hostId: string) => "relay" | null;
  readonly link: (text: string) => Promise<LinkOutcome>;
  /**
   * Revokes this device on every linked Host, then forgets them and its keys. Resolves
   * with the Hosts that didn't answer: they still trust the keys, which are kept for a retry.
   */
  readonly unlink: () => Promise<ReadonlyArray<LinkedHost>>;
  /**
   * Revokes this device on one linked Host and forgets it; the others stay linked. Resolves
   * with that Host when it didn't answer (it still trusts the keys), else empty.
   */
  readonly unlinkHost: (hostId: string) => Promise<ReadonlyArray<LinkedHost>>;
}

const RelayContext = createContext<Relay | null>(null);

const connectAll = (
  registry: HostRegistry,
  device: RelayDevice,
  hosts: ReadonlyArray<LinkedHost>
) => {
  for (const host of hosts)
    registry.addHost(host.hostId, host.hostName, relayTransport(device, host));
};

export const RelayProvider = ({ children }: { readonly children: ReactNode }) => {
  const registry = useHostRegistry();
  const registryRef = useRef(registry);
  const device = useRef<RelayDevice | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [keys, setKeys] = useState<DeviceKeys | null>(null);
  const [hosts, setHosts] = useState<ReadonlyArray<LinkedHost>>([]);

  registryRef.current = registry;

  useEffect(() => {
    let stopped = false;

    void (async () => {
      const secrets = await loadSecrets();
      const stored = secrets === null ? [] : await loadHosts();

      if (secrets !== null && !stopped) {
        const opened = await deviceKeys(secrets);

        // Unmounted while the keys opened: a device made now would never be closed, and its
        // socket would keep replacing the next mount's under the same identity (relay 4409).
        if (stopped) return;
        device.current = makeRelayDevice(opened);
        setKeys(opened);
        setHosts(stored);
        connectAll(registryRef.current, device.current, stored);
      }

      if (!stopped) setLoaded(true);
    })();

    return () => {
      stopped = true;
      device.current?.close();
      device.current = null;
    };
  }, []);

  const link = useCallback(async (text: string): Promise<LinkOutcome> => {
    const secrets = await secretsForLinking();
    const linkKeys = await deviceKeys(secrets);
    const known = await loadHosts();

    // Checked before dialing, so a refused link's one-time secret stays unused.
    const outcome = await Effect.runPromise(
      Effect.flatMap(readLink(text), (envelope) =>
        Effect.andThen(checkLinkedHosts(known, linkedHosts(envelope)), () =>
          linkDevice(envelope, linkKeys, DEVICE_NAME)
        )
      ).pipe(
        Effect.map((hosts): LinkOutcome => ({ linked: true, hosts })),
        Effect.catchTag("LinkFailed", (failure) =>
          Effect.succeed<LinkOutcome>({ linked: false, message: failure.message })
        )
      )
    );

    if (!outcome.linked) return outcome;
    const all = await saveLink(secrets, outcome.hosts);
    device.current ??= makeRelayDevice(linkKeys);
    setKeys(linkKeys);
    setHosts(all);
    // The other Hosts answer once the Desktop App shared this device to them.
    connectAll(registryRef.current, device.current, outcome.hosts);

    return outcome;
  }, []);

  const unlinkSome = useCallback(
    async (targets: ReadonlySet<string>) => {
      // A Host no longer linked has nothing to revoke; never forget the keys over it.
      if (!hosts.some((host) => targets.has(host.hostId))) return [];
      const open = device.current;
      const linked = registryRef.current.hosts.filter((h) => targets.has(h.hostId));
      const { revoked, kept, stillTrusting } = await unlinkFrom(hosts, linked, targets);

      // Only these connections: a Host linked again meanwhile has a new one.
      for (const host of linked)
        if (revoked.has(host.hostId) && registryRef.current.hosts.includes(host))
          registryRef.current.removeHost(host.hostId);

      if (kept.length > 0) {
        await keepHosts(kept);
        setHosts(kept);

        return stillTrusting;
      }

      device.current = null;
      setKeys(null);
      setHosts([]);
      await forgetLink();
      open?.close();

      return stillTrusting;
    },
    [hosts]
  );

  const unlink = useCallback(
    () => unlinkSome(new Set(hosts.map((host) => host.hostId))),
    [hosts, unlinkSome]
  );

  const unlinkHost = useCallback((hostId: string) => unlinkSome(new Set([hostId])), [unlinkSome]);

  const value = useMemo<Relay>(
    () => ({
      loaded,
      keys,
      hosts,
      routeOf: (hostId) => (hosts.some((host) => host.hostId === hostId) ? "relay" : null),
      link,
      unlink,
      unlinkHost,
    }),
    [loaded, keys, hosts, link, unlink, unlinkHost]
  );

  return <RelayContext.Provider value={value}>{children}</RelayContext.Provider>;
};

export const useRelay = (): Relay => {
  const relay = useContext(RelayContext);

  if (relay === null) throw new Error("useRelay needs a RelayProvider above it");

  return relay;
};
