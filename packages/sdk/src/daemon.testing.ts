/**
 * A real Daemon for the SDK's tests: `polaris serve` from source with a
 * throwaway POLARIS_HOME and the scripted bench Harness, plus a token-less
 * Client (as the Desktop App) that pairs Extensions and registers Workspaces.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { connectRpc, socketTransport } from "@polaris/client";
import { Command, CommandId, type GrantKind, type HostId, PairingId } from "@polaris/protocol";
import { Effect, Exit, Match, Option, Redacted, Scope, Stream } from "effect";
import { encodePairing } from "./pairing.ts";

const DAEMON_MAIN = resolve(import.meta.dir, "..", "..", "..", "apps", "daemon", "src", "main.ts");

export interface TestDaemon {
  readonly home: string;
  readonly socketPath: string;
  readonly hostId: HostId;
  /** The gateway's URL (`ws://127.0.0.1:<port>/polaris/rpc`); the port survives restarts. */
  readonly gatewayUrl: string;
  /** Pairs an Extension and returns its pairing string, for the socket or the gateway. */
  readonly pair: (
    name: string,
    grant: ReadonlyArray<GrantKind>,
    via?: "socket" | "gateway"
  ) => Promise<string>;
  readonly revoke: (pairing: string) => Promise<void>;
  /** A fresh git repository registered as a Workspace; resolves with its id. */
  readonly registerWorkspace: () => Promise<string>;
  /** Stops the Daemon and starts it again on the same home. */
  readonly restart: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

/** The user key a test Daemon's fresh home enrols first; a dev Client acting as the Desktop App presents it. */
export const TEST_USER_KEY = "5".repeat(64);

const identity = {
  clientName: "sdk-tests",
  clientVersion: "0.0.0",
  deviceLabel: "SDK tests",
  capabilities: [],
  /** Acts as the Desktop App, which pairs: the fresh home enrols it (ADR 0100). */
  userKey: Redacted.make(TEST_USER_KEY),
};

/** A port nothing listens on now, so a restarted Daemon's gateway keeps its URL. */
const freePort = () => {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port;

  void probe.stop(true);

  return port ?? 0;
};

const spawnDaemon = (home: string, gatewayPort: number, main: string) =>
  Bun.spawn(["bun", main, "serve", "--foreground"], {
    env: {
      ...process.env,
      POLARIS_HOME: home,
      POLARIS_BENCH_HARNESS: "1",
      POLARIS_GATEWAY_PORT: String(gatewayPort),
    },
    stdio: [
      "ignore",
      Bun.file(join(home, "test-daemon.log")),
      Bun.file(join(home, "test-daemon.log")),
    ],
  });

const tokenOf = new Map<string, { readonly id: string }>();

export interface LaunchOptions {
  /** The Daemon's entry point; defaults to `apps/daemon/src/main.ts`. */
  readonly main?: string;
}

export const launchDaemon = async (options: LaunchOptions = {}): Promise<TestDaemon> => {
  const main = options.main ?? DAEMON_MAIN;
  // A Unix socket path must stay short.
  const home = mkdtempSync("/tmp/pl-sdk-");
  const socketPath = join(home, "daemon.sock");
  const gatewayPort = freePort();
  const gatewayUrl = `ws://127.0.0.1:${gatewayPort}/polaris/rpc`;
  let child = spawnDaemon(home, gatewayPort, main);
  const scope = Effect.runSync(Scope.make());

  const connectAdmin = Effect.gen(function* () {
    const transport = yield* socketTransport(socketPath);
    const connection = yield* connectRpc(transport);
    const hello = yield* connection.client.hello(identity);

    return { client: connection.client, hostId: hello.host.hostId };
  });

  const connectWithRetry = async (target: Scope.Scope) => {
    for (let attempt = 0; ; attempt++) {
      const exit = await Effect.runPromiseExit(Scope.provide(connectAdmin, target));

      if (Exit.isSuccess(exit)) return exit.value;

      if (attempt > 300) throw new Error(`the Daemon at ${socketPath} never answered`);
      await Bun.sleep(100);
    }
  };

  // The Daemon opens its socket first and writes this record once its gateway is bound.
  const gatewayListening = async () => {
    const deadline = Date.now() + 30_000;

    while (!existsSync(join(home, "gateway.json"))) {
      if (Date.now() > deadline) throw new Error(`the Daemon at ${home} never bound ${gatewayUrl}`);
      await Bun.sleep(20);
    }
  };

  let admin = await connectWithRetry(scope);
  let adminScope = scope;

  await gatewayListening();

  const run = <A, E>(effect: (client: typeof admin.client) => Effect.Effect<A, E>) =>
    Effect.runPromise(effect(admin.client));

  return {
    home,
    socketPath,
    hostId: admin.hostId,
    gatewayUrl,
    pair: async (name, grant, via = "socket") => {
      const { pairing, token } = await run((client) =>
        client["extensions.pair"]({ name, grant: [...grant] })
      );

      const encoded = encodePairing({
        hostId: admin.hostId,
        hostName: "Test Host",
        url: via === "socket" ? null : gatewayUrl,
        token,
        name,
      });

      tokenOf.set(encoded, { id: pairing.id });

      return encoded;
    },
    revoke: async (encoded) => {
      const known = tokenOf.get(encoded);

      if (known === undefined) throw new Error("not a pairing from this Daemon");
      await run((client) => client["extensions.revoke"]({ id: PairingId.make(known.id) }));
    },
    registerWorkspace: async () => {
      const repo = mkdtempSync("/tmp/pl-sdk-repo-");
      const git = (...args: Array<string>) => Bun.spawnSync(["git", ...args], { cwd: repo });

      git("init", "-q");
      git("config", "user.email", "sdk@example.com");
      git("config", "user.name", "SDK tests");
      writeFileSync(join(repo, "README.md"), "hello\n");
      git("add", "-A");
      git("commit", "-qm", "init");
      const name = `sdk-repo-${crypto.randomUUID().slice(0, 8)}`;

      await run((client) =>
        client.dispatch({
          commandId: CommandId.make(crypto.randomUUID()),
          command: Command.cases.RegisterWorkspace.make({ path: repo, name }),
        })
      );

      // The Daemon picks the Workspace's id; the Host's snapshot has it.
      const head = await run((client) =>
        Stream.runHead(client.subscribeHost({ afterSequence: null }))
      );

      const workspace = Option.isSome(head)
        ? Match.value(head.value).pipe(
            Match.tag("Snapshot", ({ workspaces }) => workspaces.find((w) => w.name === name)),
            Match.orElse(() => undefined)
          )
        : undefined;

      if (workspace === undefined) throw new Error(`${name} is not in the Host's snapshot`);

      return workspace.id;
    },
    restart: async () => {
      await Effect.runPromise(Scope.close(adminScope, Exit.void));
      child.kill("SIGTERM");
      await child.exited;
      child = spawnDaemon(home, gatewayPort, main);
      adminScope = Effect.runSync(Scope.make());
      admin = await connectWithRetry(adminScope);
      await gatewayListening();
    },
    stop: async () => {
      await Effect.runPromise(Scope.close(adminScope, Exit.void));
      child.kill("SIGTERM");
      await child.exited;

      if (process.env.POLARIS_SDK_KEEP_HOME === undefined)
        rmSync(home, { recursive: true, force: true });
    },
  };
};
