/**
 * Runs the suite against another relay build: a command that reads the README's variables,
 * takes `PORT=0` for a free port, and writes wide events to stdout (apps/relay-rs/README.md).
 */
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayConfig } from "../config.ts";
import type { WideEvent } from "../wideEvent.ts";

const START_TIMEOUT_MS = 10_000;

/** The variables that give a relay process `config`. */
const environment = (config: RelayConfig) => ({
  PORT: String(config.port),
  POLARIS_RELAY_HOSTNAME: config.hostname,
  POLARIS_RELAY_TRUST_PROXY: String(config.trustProxy),
  POLARIS_RELAY_MAX_CONNECTIONS: String(config.maxConnections),
  POLARIS_RELAY_MAX_CONNECTIONS_PER_IP: String(config.maxConnectionsPerIp),
  POLARIS_RELAY_CONNECTS_PER_SECOND_PER_IP: String(config.connectsPerSecondPerIp),
  POLARIS_RELAY_CONNECT_BURST_PER_IP: String(config.connectBurstPerIp),
  POLARIS_RELAY_MAX_PEERS: String(config.maxPeers),
  POLARIS_RELAY_MESSAGES_PER_SECOND: String(config.messagesPerSecond),
  POLARIS_RELAY_BYTES_PER_SECOND: String(config.bytesPerSecond),
  POLARIS_RELAY_AUTH_TIMEOUT_MS: String(config.authTimeoutMs),
  POLARIS_RELAY_IDLE_TIMEOUT_SECONDS: String(config.idleTimeoutSeconds),
  POLARIS_RELAY_BACKPRESSURE_LIMIT_BYTES: String(config.backpressureLimitBytes),
  POLARIS_RELAY_PUSH_URL: config.push?.url ?? "",
  POLARIS_RELAY_PUSH_SECRET: config.push?.secret ?? "",
  POLARIS_RELAY_WAKES_PER_MINUTE: String(config.wakesPerMinute),
  POLARIS_RELAY_WAKE_BURST: String(config.wakeBurst),
  POLARIS_RELAY_MAX_WAKES_IN_FLIGHT: String(config.maxWakesInFlight),
  POLARIS_RELAY_MAX_LIVE_ACTIVITIES: String(config.maxLiveActivities),
  POLARIS_RELAY_LIVE_HOST_GONE_MS: String(config.liveHostGoneMs),
});

/** The whole lines of a relay's log, as the events the suite asserts on (no `time`). */
const parse = (log: string): Array<WideEvent> =>
  log
    .slice(0, log.lastIndexOf("\n") + 1)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      // SAFETY: the relay under test writes only wide events to stdout, one JSON object a line.
      const { time: _, ...event } = JSON.parse(line) as WideEvent & { time: string };

      return event;
    });

export interface ProcessRelay {
  readonly port: number;
  readonly events: ReadonlyArray<WideEvent>;
  readonly stop: () => Promise<void>;
}

/**
 * Starts `command` and waits, without yielding, for its start line. Its stdout is a file, so
 * `events` reads everything the relay has written by the time it is asked.
 */
export const startProcessRelay = (command: string, config: RelayConfig): ProcessRelay => {
  const log = join(tmpdir(), `polaris-relay-${crypto.randomUUID()}.log`);

  const child = Bun.spawn(command.split(" "), {
    cwd: `${import.meta.dir}/../..`,
    env: { ...process.env, ...environment(config) },
    stdout: Bun.file(log),
    stderr: "inherit",
  });

  const read = () => parse(readFileSync(log, "utf8"));
  const deadline = Date.now() + START_TIMEOUT_MS;
  let port: number | undefined;

  while (port === undefined) {
    port = read().find((event) => event.event === "relay.start")?.port;

    if (port !== undefined) break;

    if (child.exitCode !== null || Date.now() > deadline)
      throw new Error(`the relay did not start: ${command}`);
    Bun.sleepSync(2);
  }

  let final: ReadonlyArray<WideEvent> | null = null;

  return {
    port,
    get events() {
      return final ?? read();
    },
    stop: async () => {
      if (final !== null) return;
      child.kill("SIGTERM");
      await child.exited;
      final = read();
      rmSync(log, { force: true });
    },
  };
};
