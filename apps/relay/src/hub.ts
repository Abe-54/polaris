/**
 * Who is online and who may reach whom. A host names its linked devices; a
 * device and a host reach each other only while the host lists the device.
 * Held in memory for the life of the connections, never persisted.
 */
import { encodeControl, type RelayAddress, type RelayRole } from "@polaris/protocol/relay";

export interface Endpoint {
  readonly address: RelayAddress;
  readonly role: RelayRole;
  /** Sends a control message, after every data frame already forwarded to this socket. */
  readonly send: (message: string) => void;
  /** Forwards a data frame; small frames of one event-loop turn share a write (ADR 0104). */
  readonly forward: (frame: Uint8Array) => void;
  /** Closes the socket because a newer connection proved the same key. */
  readonly replace: () => void;
}

const presence = (peer: RelayAddress, online: boolean) =>
  encodeControl({ t: "presence", peer, online });

export class Hub {
  private readonly online = new Map<RelayAddress, Endpoint>();
  /** Host → the devices it links. */
  private readonly devicesOf = new Map<RelayAddress, ReadonlySet<RelayAddress>>();
  /** Device → the online hosts that link it. */
  private readonly hostsOf = new Map<RelayAddress, Set<RelayAddress>>();

  /** Registers `endpoint`, replacing an older connection of the same key, and announces it. */
  attach(endpoint: Endpoint, peers: ReadonlyArray<RelayAddress>): void {
    const previous = this.online.get(endpoint.address);

    if (previous !== undefined) {
      this.unlink(previous);
      previous.replace();
    }

    this.online.set(endpoint.address, endpoint);

    if (endpoint.role === "host") this.setPeers(endpoint, peers);
    else
      for (const host of this.hostsOf.get(endpoint.address) ?? [])
        this.announce(host, endpoint.address, true);
  }

  /** Removes `endpoint` if it is still the current connection for its key. */
  detach(endpoint: Endpoint): void {
    if (this.online.get(endpoint.address) !== endpoint) return;
    this.online.delete(endpoint.address);

    if (endpoint.role === "host") this.setPeers(endpoint, []);
    else
      for (const host of this.hostsOf.get(endpoint.address) ?? [])
        this.announce(host, endpoint.address, false);
    this.devicesOf.delete(endpoint.address);
  }

  /** Replaces a host's linked devices, announcing each change to whoever is online. */
  setPeers(host: Endpoint, peers: ReadonlyArray<RelayAddress>): void {
    const before = this.devicesOf.get(host.address) ?? new Set<RelayAddress>();
    const after = new Set(this.online.get(host.address) === host ? peers : []);
    this.devicesOf.set(host.address, after);

    for (const device of before) {
      if (after.has(device)) continue;
      this.forget(host.address, device);
      this.announce(host.address, device, false);
    }

    for (const device of after) {
      if (before.has(device)) continue;
      const hosts = this.hostsOf.get(device) ?? new Set<RelayAddress>();
      hosts.add(host.address);
      this.hostsOf.set(device, hosts);
      this.announce(host.address, device, true);
    }
  }

  /** Drops `host` from `device`'s hosts, and the entry with its last host. */
  private forget(host: RelayAddress, device: RelayAddress): void {
    const hosts = this.hostsOf.get(device);

    if (hosts?.delete(host) === true && hosts.size === 0) this.hostsOf.delete(device);
  }

  /** The endpoint `from` may deliver to at `to`, or undefined when it is offline or not linked. */
  route(from: Endpoint, to: RelayAddress): Endpoint | undefined {
    const target = this.online.get(to);

    if (target === undefined || target.role === from.role) return undefined;
    const host = from.role === "host" ? from.address : to;
    const device = from.role === "host" ? to : from.address;

    return this.devicesOf.get(host)?.has(device) === true ? target : undefined;
  }

  /** The online host at `address`, if any. */
  host(address: RelayAddress): Endpoint | undefined {
    return this.endpoint(address, "host");
  }

  get size(): number {
    return this.online.size;
  }

  /**
   * Tells a host and a device that the other came (both online) or went
   * (whichever is still online).
   */
  private announce(host: RelayAddress, device: RelayAddress, online: boolean): void {
    const hostEndpoint = this.endpoint(host, "host");
    const deviceEndpoint = this.endpoint(device, "device");

    if (online && (hostEndpoint === undefined || deviceEndpoint === undefined)) return;
    hostEndpoint?.send(presence(device, online));
    deviceEndpoint?.send(presence(host, online));
  }

  private endpoint(address: RelayAddress, role: RelayRole): Endpoint | undefined {
    const endpoint = this.online.get(address);

    return endpoint?.role === role ? endpoint : undefined;
  }

  private unlink(previous: Endpoint): void {
    this.online.delete(previous.address);

    if (previous.role === "host") this.setPeers(previous, []);
    this.devicesOf.delete(previous.address);
  }
}
