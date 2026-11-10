/**
 * For tests: the real Polaris Relay (apps/relay's binary) on a fixed port, so it
 * can stop and start again at the same URL, and a real Daemon whose secrets stay off the
 * Keychain with the Relay route on.
 */
import { connectRpc, type DaemonClient } from "@polaris/client/rpc";
import { relayBinary } from "@polaris/relay/testing/binary";
import { socketTransport } from "@polaris/sdk";
import { launchDaemon, TEST_USER_KEY, type TestDaemon } from "@polaris/sdk/testing";
import { Effect, Exit, Redacted, Scope } from "effect";

// Built here, as the file loads, so no test's timeout pays for a cold build.
const RELAY = relayBinary();

const TEST_DAEMON_MAIN = new URL("../../daemon/src/main.testing.ts", import.meta.url).pathname;

const freePort = (): number => {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port ?? 0;

  void probe.stop(true);

  return port;
};

export interface TestRelay {
  readonly url: string;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

export const relayProcess = (port = freePort()): TestRelay => {
  let child: Bun.Subprocess<"ignore", "pipe", "inherit"> | null = null;

  const start = async () => {
    const spawned = Bun.spawn([RELAY], {
      env: {
        ...process.env,
        PORT: String(port),
        POLARIS_RELAY_HOSTNAME: "127.0.0.1",
        POLARIS_RELAY_CONNECT_BURST_PER_IP: "200",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
    });

    child = spawned;
    const reader = spawned.stdout.getReader();
    let text = "";
    const deadline = Date.now() + 10_000;

    while (!text.includes('"relay.start"')) {
      if (Date.now() > deadline) throw new Error("the relay did not start");
      const { value, done } = await reader.read();

      if (done) throw new Error("the relay exited");
      text += new TextDecoder().decode(value);
    }

    // Keep draining its log so the pipe never fills.
    void (async () => {
      for (;;) if ((await reader.read()).done) break;
    })();
  };

  return {
    url: `ws://127.0.0.1:${port}/v1`,
    start,
    stop: async () => {
      child?.kill("SIGTERM");
      await child?.exited;
      child = null;
    },
  };
};

/** Waits until the Daemon's relay socket proved its key. */
export const connectedTo = async (client: DaemonClient, ms = 20_000) => {
  const deadline = Date.now() + ms;

  while (!(await Effect.runPromise(client["relayRoute.status"]())).connected) {
    if (Date.now() > deadline) throw new Error("the Daemon never connected to the relay");
    await Bun.sleep(50);
  }
};

export interface RelayDaemon {
  readonly daemon: TestDaemon;
  /** The Desktop App's view: a token-less Client on the Daemon's socket. */
  readonly client: DaemonClient;
  readonly stop: () => Promise<void>;
}

/** A Daemon with the Relay route on `relayUrl`; HostSecrets in its home, not the Keychain. */
export const launchRelayDaemon = async (relayUrl: string): Promise<RelayDaemon> => {
  const daemon = await launchDaemon({ main: TEST_DAEMON_MAIN });
  const scope = Effect.runSync(Scope.make());

  const client = await Effect.runPromise(
    Scope.provide(
      Effect.gen(function* () {
        const connection = yield* connectRpc(
          yield* socketTransport(daemon.socketPath, daemon.hostId)
        );

        yield* connection.client.hello({
          clientName: "relay-tests",
          clientVersion: "0.0.0",
          deviceLabel: "Relay tests",
          capabilities: [],
          // Acts as the Desktop App, which turns the relay route on (ADR 0100).
          userKey: Redacted.make(TEST_USER_KEY),
        });

        return connection.client;
      }),
      scope
    )
  );

  await Effect.runPromise(client["relayRoute.enable"]({ url: relayUrl }));
  await connectedTo(client);

  return {
    daemon,
    client,
    stop: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await daemon.stop();
    },
  };
};

/** The phone's TCP path to the relay: what goes through it, until `cut` kills it silently. */
export interface SilentPath {
  /** The relay URL through the path. */
  readonly url: string;
  /**
   * Cuts every open connection the way a network change does: the relay's side
   * closes, the phone's stays open and hears nothing. Later connections go through.
   */
  readonly cut: () => void;
  readonly stop: () => void;
}

interface Pipe {
  relay: Bun.Socket<undefined> | null;
  cut: boolean;
  held: Array<Uint8Array>;
}

export const silentPath = (relayUrl: string): SilentPath => {
  const target = new URL(relayUrl);
  const pipes = new Set<Pipe>();

  const listener = Bun.listen<Pipe>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(phone) {
        const pipe: Pipe = { relay: null, cut: false, held: [] };
        phone.data = pipe;
        pipes.add(pipe);
        void Bun.connect({
          hostname: target.hostname,
          port: Number(target.port),
          socket: {
            data: (_relay, bytes) => {
              if (!pipe.cut) phone.write(bytes);
            },
            close: () => {
              if (!pipe.cut) phone.end();
            },
          },
        }).then((relay) => {
          pipe.relay = relay;
          pipe.held.forEach((bytes) => relay.write(bytes));
        });
      },
      data(phone, bytes) {
        const pipe = phone.data;

        if (pipe.cut) return;

        if (pipe.relay === null) pipe.held.push(bytes.slice());
        else pipe.relay.write(bytes);
      },
      close(phone) {
        if (!phone.data.cut) phone.data.relay?.end();
      },
    },
  });

  return {
    url: `ws://127.0.0.1:${listener.port}${target.pathname}`,
    cut: () => {
      for (const pipe of pipes) {
        pipe.cut = true;
        pipe.relay?.end();
      }
    },
    stop: () => listener.stop(true),
  };
};
