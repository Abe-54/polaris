/**
 * Starts a relay on a free port with small limits, collecting its wide events: this one in
 * process, or the build `POLARIS_RELAY_COMMAND` names (the Rust relay) as a process.
 */
import { type RelayAddress, toBase64Url } from "@polaris/protocol/relay";
import {
  addressOf,
  generateRelayIdentity,
  type RelayIdentity,
} from "@polaris/protocol/relay/party";
import { defaultRelayConfig, type RelayConfig } from "../config.ts";
import { startRelay } from "../server.ts";
import type { WideEvent } from "../wideEvent.ts";
import { startProcessRelay } from "./processRelay.ts";

export interface TestRelay {
  readonly port: number;
  readonly url: string;
  readonly events: ReadonlyArray<WideEvent>;
  readonly stop: () => Promise<void>;
}

/** Another relay build to run the suite against, as a command line; unset for this one. */
export const relayCommand = process.env.POLARIS_RELAY_COMMAND ?? "";

export const testConfig: RelayConfig = {
  ...defaultRelayConfig,
  port: 0,
  hostname: "127.0.0.1",
  connectsPerSecondPerIp: 1_000,
  connectBurstPerIp: 1_000,
  maxConnectionsPerIp: 1_000,
  maxPeers: 4,
  messagesPerSecond: 100,
  authTimeoutMs: 1_000,
};

export const startTestRelay = (overrides: Partial<RelayConfig> = {}): TestRelay => {
  const config = { ...testConfig, ...overrides };
  const url = (port: number) => `ws://127.0.0.1:${port}/v1`;

  if (relayCommand !== "") {
    const relay = startProcessRelay(relayCommand, config);

    return {
      port: relay.port,
      url: url(relay.port),
      stop: relay.stop,
      get events() {
        return relay.events;
      },
    };
  }

  const events: Array<WideEvent> = [];
  const relay = startRelay(config, (event) => events.push(event));

  return { port: relay.port, url: url(relay.port), events, stop: relay.stop };
};

export interface Identified {
  readonly identity: RelayIdentity;
  readonly address: RelayAddress;
  /** Everything about the party a log line must never contain. */
  readonly secrets: ReadonlyArray<string>;
}

export const identify = async (): Promise<Identified> => {
  const identity = generateRelayIdentity();
  const address = await addressOf(identity);

  return { identity, address, secrets: [address, toBase64Url(identity.publicKey)] };
};
