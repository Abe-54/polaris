/**
 * Host addresses in the Browser (ADR 0093): each Workspace's partition sends them to its
 * Host, through an authenticated HTTP proxy per remote Host whose connections become
 * Host-address streams.
 */
import { isHostAddress } from "@polaris/protocol";
import type { Effect, Fiber } from "effect";
import type { AuthInfo, Session } from "electron";
import { configurePartition, type PartitionRoute, retirePartition } from "./partition.ts";
import { PROXY_USER } from "./proxy.ts";
import { type OpenHostAddress, type ProxyServer, startProxyServer } from "./server.ts";

export interface ProxyCredentials {
  readonly username: string;
  readonly password: string;
}

export interface HostAddresses {
  /**
   * Sets up a Workspace's partition; `browser/views.ts` waits on it before every load. A
   * setup in flight or done is shared; a failed one is dropped, so the next call retries.
   */
  readonly configureBrowserSession: (hostKey: string, session: Session) => Promise<void>;
  /**
   * The credentials for a `login` event: only a proxy challenge from the partition's own
   * proxy, for a page in that partition. Anything else gets null and is cancelled.
   */
  readonly proxyLogin: (
    session: Session | undefined,
    authInfo: Pick<AuthInfo, "isProxy" | "host" | "port" | "realm">
  ) => ProxyCredentials | null;
  /**
   * A removed Host: its partitions lose the Host-address certificate rule, then its proxy
   * stops relaying. The proxy keeps its port until no partition points at it any more.
   */
  readonly forget: (hostKey: string) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

export interface HostAddressesInput<R> {
  /** The Host's loopback is this machine's: the local Host, or one on a local socket. */
  readonly isLocal: (hostKey: string) => boolean;
  readonly open: (hostKey: string) => OpenHostAddress<R>;
  readonly run: (effect: Effect.Effect<void, never, R>) => Fiber.Fiber<void>;
  /** Applies a route to a partition; `configurePartition` outside tests. */
  readonly configure?: (session: Session, route: PartitionRoute) => Promise<void>;
  /** Takes a removed Host's rules off a partition; `retirePartition` outside tests. */
  readonly retire?: (session: Session) => Promise<void>;
}

interface Setup {
  readonly hostKey: string;
  readonly ready: Promise<void>;
  /** This setup's identity: a run whose token is no longer current does nothing more. */
  readonly token: object;
}

/** A setup that finished after its Host was removed: its rules came off again. */
const removedWhileSettingUp = (hostKey: string) =>
  new Error(`${hostKey} was removed while its partition was being set up`);

export const createHostAddresses = <R>({
  isLocal,
  open,
  run,
  configure = (session, route) => configurePartition(session, route, isHostAddress),
  retire = retirePartition,
}: HostAddressesInput<R>): HostAddresses => {
  const servers = new Map<string, Promise<ProxyServer>>();
  const started = new Map<string, ProxyServer>();
  const setups = new Map<Session, Setup>();
  /** Each partition's latest setup or retirement, kept past `forget`: they run one at a time. */
  const runs = new Map<Session, Promise<void>>();

  const queued = (session: Session, task: () => Promise<void>) => {
    const run = (runs.get(session) ?? Promise.resolve()).catch(() => undefined).then(task);

    runs.set(session, run);

    return run;
  };
  /** Retired proxies, each with the partitions still pointing at it. */

  const retired = new Map<ProxyServer, Set<Session>>();

  const release = async (server: ProxyServer) => {
    if ((retired.get(server)?.size ?? 0) > 0) return;
    retired.delete(server);
    await server.close();
  };

  /** A partition set up again no longer points at any retired proxy. */
  const moved = (session: Session) =>
    Promise.all(
      [...retired].map(async ([server, sessions]) => {
        if (sessions.delete(session)) await release(server);
      })
    );

  const serverFor = (hostKey: string) => {
    let server = servers.get(hostKey);

    if (server === undefined) {
      const starting = startProxyServer({ open: open(hostKey), isHostAddress, run });

      server = starting;
      servers.set(hostKey, starting);
      starting.then(
        (value) => started.set(hostKey, value),
        () => servers.get(hostKey) === starting && servers.delete(hostKey)
      );
    }

    return server;
  };

  const setUp = async (hostKey: string, session: Session) =>
    configure(
      session,
      isLocal(hostKey)
        ? { kind: "local" }
        : { kind: "remote", proxyPort: (await serverFor(hostKey)).port }
    );

  const forget = async (hostKey: string) => {
    const starting = servers.get(hostKey);

    const sessions = [...setups].flatMap(([session, setup]) =>
      setup.hostKey === hostKey ? [session] : []
    );

    // Synchronously, so a setup asked for right after starts afresh on a new proxy.
    servers.delete(hostKey);
    started.delete(hostKey);
    sessions.forEach((session) => setups.delete(session));

    const registered = (async () => {
      const server = await starting?.catch(() => null);

      server?.retire();

      if (server != null) retired.set(server, new Set(sessions));

      return server;
    })();

    // Queued now, behind any setup in flight and ahead of any asked for later.
    const retiring = sessions.map((session) =>
      queued(session, async () => {
        await retire(session).catch(() => undefined);
        await registered;
      })
    );

    const server = await registered;

    await Promise.all(retiring);

    if (server != null) await release(server);
  };

  return {
    configureBrowserSession: (hostKey, session) => {
      const current = setups.get(session);

      if (current?.hostKey === hostKey) return current.ready;
      const token = {};
      const stillCurrent = () => setups.get(session)?.token === token;

      const ready = queued(session, async () => {
        if (!stillCurrent()) throw removedWhileSettingUp(hostKey);
        await setUp(hostKey, session);

        // Removed meanwhile: its retirement runs next, and the retired port stays held.
        if (!stillCurrent()) throw removedWhileSettingUp(hostKey);
        await moved(session);
      });

      setups.set(session, { hostKey, ready, token });
      ready.catch(() => {
        if (setups.get(session)?.ready === ready) setups.delete(session);
      });

      return ready;
    },
    proxyLogin: (session, authInfo) => {
      const setup = session === undefined ? undefined : setups.get(session);
      const server = setup === undefined ? undefined : started.get(setup.hostKey);

      if (server === undefined || !authInfo.isProxy || authInfo.realm !== server.realm) return null;

      // The realm is random per launch, and the proxy never relays a page's own 407 (502).
      // Even so the secret only goes to this proxy, which strips it before forwarding.
      return authInfo.host === "127.0.0.1" && authInfo.port === server.port
        ? { username: PROXY_USER, password: server.secret }
        : null;
    },
    forget,
    dispose: async () => {
      await Promise.all([...servers.keys()].map(forget));
      await Promise.all([...retired.keys()].map((server) => server.close()));
      retired.clear();
    },
  };
};
