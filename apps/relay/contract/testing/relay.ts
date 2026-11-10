/**
 * Starts the relay binary on a free port with small limits and collects its log lines.
 */
import { type RelayAddress, toBase64Url } from "@polaris/protocol/relay";
import {
  addressOf,
  generateRelayIdentity,
  type RelayIdentity,
} from "@polaris/protocol/relay/party";
import { relayBinary } from "./binary.ts";
import type { WideEvent } from "./events.ts";
import { type RelayConfig, startProcessRelay } from "./processRelay.ts";

export type { RelayConfig } from "./processRelay.ts";

export interface TestRelay {
  readonly port: number;
  readonly url: string;
  readonly events: ReadonlyArray<WideEvent>;
  readonly stop: () => Promise<void>;
}

// Built as the file loads, so no test's timeout pays for a cold build.
const binary = relayBinary();

/** The relay's defaults (README: Limits and close codes), with room to connect freely and short waits. */
export const testConfig: RelayConfig = {
  port: 0,
  hostname: "127.0.0.1",
  trustProxy: false,
  maxConnections: 10_000,
  maxConnectionsPerIp: 1_000,
  connectsPerSecondPerIp: 1_000,
  connectBurstPerIp: 1_000,
  maxPeers: 4,
  messagesPerSecond: 100,
  bytesPerSecond: 8 * 1024 * 1024,
  authTimeoutMs: 1_000,
  idleTimeoutSeconds: 60,
  backpressureLimitBytes: 16 * 1024 * 1024,
  push: null,
  wakesPerMinute: 60,
  wakeBurst: 20,
  maxWakesInFlight: 256,
  maxLiveActivities: 10_000,
  liveHostGoneMs: 120_000,
};

export const startTestRelay = (overrides: Partial<RelayConfig> = {}): TestRelay => {
  const relay = startProcessRelay(binary, { ...testConfig, ...overrides });

  return {
    port: relay.port,
    url: `ws://127.0.0.1:${relay.port}/v1`,
    stop: relay.stop,
    get events() {
      return relay.events;
    },
  };
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
