import type {
  DeviceKeys,
  deviceKeys,
  LinkedHost,
  makeRelayDevice,
  RelayDevice,
} from "@polaris/client/relay";
import type { loadHosts, loadSecrets } from "./store.ts";

export const startRelay = async (
  stopped: () => boolean,
  ready: (device: RelayDevice, keys: DeviceKeys, hosts: ReadonlyArray<LinkedHost>) => void,
  loaded: () => void,
  dependencies: {
    loadSecrets: typeof loadSecrets;
    loadHosts: typeof loadHosts;
    deviceKeys: typeof deviceKeys;
    makeRelayDevice: typeof makeRelayDevice;
  }
) => {
  const { loadSecrets, loadHosts, deviceKeys, makeRelayDevice } = dependencies;
  const secrets = await loadSecrets();
  const stored = secrets === null ? [] : await loadHosts();

  if (secrets !== null && !stopped()) {
    const opened = await deviceKeys(secrets);

    // Unmounted while the keys opened: a device made now would never be closed, and its
    // socket would keep replacing the next mount's under the same identity (relay 4409).
    if (stopped()) return;
    ready(makeRelayDevice(opened), opened, stored);
  }

  if (!stopped()) loaded();
};
