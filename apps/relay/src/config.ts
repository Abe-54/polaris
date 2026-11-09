/** The relay's settings, from the environment (README: Configuration). */
import { Config, ConfigProvider, Effect, Option, Redacted } from "effect";
import type { GateLimits } from "./limits.ts";

export interface RelayConfig extends GateLimits {
  readonly port: number;
  readonly hostname: string;
  /** Read the client's address from the first `X-Forwarded-For` hop (behind Railway's proxy). */
  readonly trustProxy: boolean;
  readonly maxPeers: number;
  readonly messagesPerSecond: number;
  readonly bytesPerSecond: number;
  readonly authTimeoutMs: number;
  /** Seconds without traffic (pongs count) before a socket is closed; Bun pings in between. */
  readonly idleTimeoutSeconds: number;
  /** Bytes queued to a slow receiver before the relay closes it. */
  readonly backpressureLimitBytes: number;
  /** The push service and its shared secret; without both the relay forwards no wakes. */
  readonly push: { readonly url: string; readonly secret: string } | null;
  /** Wakes a host may ask for, per minute, with a burst of `wakeBurst`. */
  readonly wakesPerMinute: number;
  readonly wakeBurst: number;
  /** Wakes waiting on the push service at once, across all hosts. */
  readonly maxWakesInFlight: number;
  /** Live Activities the relay holds slices for at once (ADR 0088). */
  readonly maxLiveActivities: number;
  /** How long a host's socket may be gone before its Live Activity slices leave (ENG-585). */
  readonly liveHostGoneMs: number;
}

export const defaultRelayConfig: RelayConfig = {
  port: 8080,
  hostname: "0.0.0.0",
  trustProxy: false,
  maxConnections: 10_000,
  maxConnectionsPerIp: 32,
  connectsPerSecondPerIp: 1,
  connectBurstPerIp: 20,
  maxPeers: 64,
  messagesPerSecond: 500,
  bytesPerSecond: 8 * 1024 * 1024,
  authTimeoutMs: 10_000,
  idleTimeoutSeconds: 60,
  backpressureLimitBytes: 16 * 1024 * 1024,
  push: null,
  wakesPerMinute: 60,
  wakeBurst: 20,
  maxWakesInFlight: 256,
  maxLiveActivities: 10_000,
  liveHostGoneMs: 120_000,
};

const int = (name: string, fallback: number) => Config.Int(name).pipe(Config.withDefault(fallback));

const d = defaultRelayConfig;

/** Both variables or neither: a URL without its secret, or the reverse, is a misconfiguration. */
const pushConfig = Config.all({
  url: Config.option(Config.URL("POLARIS_RELAY_PUSH_URL")),
  secret: Config.option(Config.Redacted("POLARIS_RELAY_PUSH_SECRET")),
}).pipe(
  Config.mapEffect(({ url, secret }) => {
    if (Option.isNone(url) && Option.isNone(secret)) return Effect.succeed(null);

    if (Option.isNone(url) || Option.isNone(secret))
      return Effect.fail(
        new Config.ConfigError(
          new ConfigProvider.SourceError({
            message: "Set both POLARIS_RELAY_PUSH_URL and POLARIS_RELAY_PUSH_SECRET, or neither",
          })
        )
      );

    return Effect.succeed({ url: url.value.href, secret: Redacted.value(secret.value) });
  })
);

export const relayConfig: Config.Config<RelayConfig> = Config.all({
  port: Config.Port("PORT").pipe(Config.withDefault(d.port)),
  hostname: Config.String("POLARIS_RELAY_HOSTNAME").pipe(Config.withDefault(d.hostname)),
  trustProxy: Config.Boolean("POLARIS_RELAY_TRUST_PROXY").pipe(Config.withDefault(d.trustProxy)),
  maxConnections: int("POLARIS_RELAY_MAX_CONNECTIONS", d.maxConnections),
  maxConnectionsPerIp: int("POLARIS_RELAY_MAX_CONNECTIONS_PER_IP", d.maxConnectionsPerIp),
  connectsPerSecondPerIp: int("POLARIS_RELAY_CONNECTS_PER_SECOND_PER_IP", d.connectsPerSecondPerIp),
  connectBurstPerIp: int("POLARIS_RELAY_CONNECT_BURST_PER_IP", d.connectBurstPerIp),
  maxPeers: int("POLARIS_RELAY_MAX_PEERS", d.maxPeers),
  messagesPerSecond: int("POLARIS_RELAY_MESSAGES_PER_SECOND", d.messagesPerSecond),
  bytesPerSecond: int("POLARIS_RELAY_BYTES_PER_SECOND", d.bytesPerSecond),
  authTimeoutMs: int("POLARIS_RELAY_AUTH_TIMEOUT_MS", d.authTimeoutMs),
  idleTimeoutSeconds: int("POLARIS_RELAY_IDLE_TIMEOUT_SECONDS", d.idleTimeoutSeconds),
  backpressureLimitBytes: int("POLARIS_RELAY_BACKPRESSURE_LIMIT_BYTES", d.backpressureLimitBytes),
  push: pushConfig,
  wakesPerMinute: int("POLARIS_RELAY_WAKES_PER_MINUTE", d.wakesPerMinute),
  wakeBurst: int("POLARIS_RELAY_WAKE_BURST", d.wakeBurst),
  maxWakesInFlight: int("POLARIS_RELAY_MAX_WAKES_IN_FLIGHT", d.maxWakesInFlight),
  maxLiveActivities: int("POLARIS_RELAY_MAX_LIVE_ACTIVITIES", d.maxLiveActivities),
  liveHostGoneMs: int("POLARIS_RELAY_LIVE_HOST_GONE_MS", d.liveHostGoneMs),
});
