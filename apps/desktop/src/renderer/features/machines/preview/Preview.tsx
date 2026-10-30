/**
 * Settings → Hosts on fixtures, for screenshots and the smoke: `#hosts/all`,
 * `#hosts/current`, `#hosts/failures`, `#hosts/live`, where Update walks a
 * fake host through checking, copying and switching, and `#hosts/wsl`, a
 * Windows PC with WSL Hosts and distros to add, and `#hosts/task`, Windows installs held by
 * a sign-in task another Polaris home holds, and `#hosts/states`, the redesigned list and host
 * page with live stats and Restart daemon. Nothing is installed.
 */
import { HostInfo } from "@polaris/protocol";
import { Option, Schema } from "effect";
import { createRoot } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import type { MachineView, PolarisApi, Result } from "../../../../shared/api.ts";
import type { DaemonUpdateView } from "../../../../shared/daemonUpdates.ts";
import { App } from "../../../app/App.tsx";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { type AppState, type Connection, initialState } from "../../../store/store.ts";
import { standInBridge } from "../../bridge.ts";
import { machinesFor, type Scene, SCENES, SSH_ALIASES, WSL_DISTROS } from "./fixtures.ts";
import { setResourcesClient } from "../../settings/resources.ts";
import { fakeResources } from "../../sessions/preview/settingsFixtures.ts";
import { fakeStats, RESTART_MS, RESTART_PREVIEW, restartOutcome } from "./stats.ts";
import { availability, hostViews } from "./workers.ts";

const OK: Result<null> = { ok: true, value: null };

const UNSUPPORTED = { ok: false, error: { code: "Unsupported", message: "preview" } } as const;

const TOTAL = 18_600_000;

/** The fake machines feed: a list, and a way to change one Host's update facts. */
const createFeed = (initial: ReadonlyArray<MachineView>) => {
  let machines = initial;
  const listeners = new Set<(list: ReadonlyArray<MachineView>) => void>();

  const publish = () => {
    for (const listener of listeners) listener(machines);
  };

  const patch = (keys: ReadonlyArray<string> | null, change: Partial<DaemonUpdateView>) => {
    machines = machines.map((m) =>
      m.daemon !== null && (keys === null || keys.includes(m.key))
        ? { ...m, daemon: { ...m.daemon, ...change } }
        : m
    );
    publish();
  };

  const listen = (listener: (list: ReadonlyArray<MachineView>) => void) => {
    listeners.add(listener);
    queueMicrotask(() => listener(machines));

    return () => listeners.delete(listener);
  };

  /** A host's Connection State, for the preview's restart. */
  const status = (key: string, change: (view: MachineView) => MachineView["status"]) => {
    machines = machines.map((m) => (m.key === key ? { ...m, status: change(m) } : m));
    publish();
  };

  return { listen, patch, status, get: () => machines };
};

type Feed = ReturnType<typeof createFeed>;

/** Checking, then copying in real-looking chunks, then switching, then done. */
const simulateUpdate = (feed: Feed, hostKey: string) => {
  const target = feed.get().find((m) => m.key === hostKey)?.daemon;

  if (target === null || target === undefined) return;
  const from = target.installedVersion;
  const version = target.bundledVersion;

  const steps: Array<[number, Partial<DaemonUpdateView>]> = [
    [0, { progress: { stage: "checking", bytes: 0, total: 0 }, lastUpdate: null }],
    ...Array.from({ length: 11 }, (_, i): [number, Partial<DaemonUpdateView>] => [
      700 + i * 220,
      { progress: { stage: "uploading", bytes: Math.round((TOTAL * i) / 10), total: TOTAL } },
    ]),
    [3300, { progress: { stage: "switching", bytes: 0, total: 0 } }],
    [
      4600,
      {
        progress: null,
        installedVersion: version,
        updateAvailable: false,
        lastUpdate: { at: Date.now() + 4600, result: "updated", from, version, problem: null },
      },
    ],
  ];

  for (const [at, change] of steps) setTimeout(() => feed.patch([hostKey], change), at);
};

const Input = Schema.Struct({
  hostKey: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
  url: Schema.optional(Schema.String),
});

/** Each host's Polaris Relay: on and reaching one phone on Mac Studio, off elsewhere. */
const relays = new Map<string, string>([["studio", "wss://relay.lux.dev/v1"]]);

const relayOf = (hostKey: string): Result<unknown> => {
  const url = relays.get(hostKey) ?? null;

  return {
    ok: true,
    value: {
      state: url === null ? "off" : "on",
      url,
      connected: url !== null,
      hostAddress: `${hostKey}.relay`,
      hostNoiseKey: "preview",
    },
  };
};

/** Each host's remote access, off until switched on. */
const remoteAccessOn = new Set<string>();

const remoteAccessOf = (hostKey: string): Result<unknown> => {
  const hostName = `${hostKey}.tail1234.ts.net`;
  const on = remoteAccessOn.has(hostKey);

  return {
    ok: true,
    value: {
      state: on ? "on" : "off",
      url: on ? `wss://${hostName}/polaris/rpc` : null,
      hostName,
      reason: null,
    },
  };
};

const tailscaleAnswer = (method: string, hostKey: string) => {
  if (method === "remoteAccess.enable") remoteAccessOn.add(hostKey);

  if (method === "remoteAccess.disable") remoteAccessOn.delete(hostKey);

  return remoteAccessOf(hostKey);
};

/** Turning the relay on keeps the URL it was given; off forgets it. */
const relayAnswer = (method: string, hostKey: string, url: string | undefined) => {
  if (method === "relayRoute.enable" && url !== undefined) relays.set(hostKey, url);

  if (method === "relayRoute.disable") relays.delete(hostKey);

  return relayOf(hostKey);
};

/** The three update requests change the feed; "Add a host" is answered on the `wsl` scene; the rest "unsupported" (a toast). */
const answer = (
  feed: Feed,
  scene: Scene,
  method: string,
  { hostKey, enabled, url }: typeof Input.Type
): Result<unknown> | null => {
  switch (method) {
    case "machines.wslDistros":
      return scene === "wsl" ? { ok: true, value: WSL_DISTROS } : null;
    case "machines.sshAliases":
      return scene === "wsl" ? { ok: true, value: SSH_ALIASES } : null;
    case "machines.updateDaemon":
      if (hostKey !== undefined) simulateUpdate(feed, hostKey);

      return OK;
    case "machines.setKeepDaemonsUpToDate":
      feed.patch(null, { keepDaemonsUpToDate: enabled === true });
      // The effective choice follows for hosts without their own.
      feed.patch(
        feed
          .get()
          .filter((m) => m.daemon?.keepUpToDateOverride === null)
          .map((m) => m.key),
        { keepUpToDate: enabled === true }
      );

      return OK;
    case "machines.setDaemonUpdateOverride": {
      const all = feed.get().find((m) => m.key === hostKey)?.daemon?.keepDaemonsUpToDate ?? true;

      if (hostKey !== undefined)
        feed.patch([hostKey], {
          keepUpToDateOverride: enabled ?? null,
          keepUpToDate: enabled ?? all,
        });

      return OK;
    }

    case "remoteAccess.enable":
    case "remoteAccess.disable":
    case "remoteAccess.status":
      return hostKey === undefined ? null : tailscaleAnswer(method, hostKey);
    case "relayRoute.enable":
    case "relayRoute.disable":
    case "relayRoute.status":
      return hostKey === undefined ? null : relayAnswer(method, hostKey, url);
    case "devices.list":
      return { ok: true, value: hostKey === "studio" ? [{ unlinkedAt: null }] : [] };
    case "clipboard.write":
      return OK;
    case "machines.restartPreview":
      return { ok: true, value: RESTART_PREVIEW };
    case "harness.availability":
      return { ok: true, value: availability() };
    default:
      return null;
  }
};

/** Reconnecting while it restarts, then back with a new start time (or still down when it fails). */
const restart = (feed: Feed, hostKey: string): Promise<Result<unknown>> => {
  const before = feed.get().find((m) => m.key === hostKey)?.status ?? null;

  feed.status(hostKey, (m) =>
    m.status === null ? null : { ...m.status, state: "reconnecting", since: Date.now() }
  );

  return new Promise((resolve) =>
    setTimeout(() => {
      const outcome = restartOutcome(hostKey);
      const host = before?.host ?? null;

      if (outcome.outcome === "back" && before !== null && host !== null)
        feed.status(hostKey, () => ({
          ...before,
          host: HostInfo.make({
            hostId: host.hostId,
            hostname: host.hostname,
            platform: host.platform,
            daemonVersion: host.daemonVersion,
            homeDir: host.homeDir,
            startedAt: outcome.startedAt,
          }),
        }));
      resolve({ ok: true, value: outcome });
    }, RESTART_MS)
  );
};

const bridgeFor = (feed: Feed, scene: Scene): PolarisApi => ({
  request: (method, input) => {
    const fields: typeof Input.Type = Option.getOrElse(
      Schema.decodeUnknownOption(Input)(input),
      () => ({})
    );

    if (method === "machines.restartDaemon" && fields.hostKey !== undefined)
      // SAFETY: restartDaemon's output is a RestartDaemonResult.
      return restart(feed, fields.hostKey) as never;

    // SAFETY: every request this preview answers returns that request's output type.
    return Promise.resolve((answer(feed, scene, method, fields) ?? UNSUPPORTED) as never);
  },
  subscribe: (kind, input, listener) => {
    const fields: typeof Input.Type = Option.getOrElse(
      Schema.decodeUnknownOption(Input)(input),
      () => ({})
    );

    if (kind === "host.stats" && fields.hostKey !== undefined)
      // SAFETY: the stats feed's items are HostStatsItems.
      return fakeStats(fields.hostKey, (items) => listener.items(items as never));

    if (kind === "harness.availability") {
      // SAFETY: the availability feed's items are HostHarnesses reports.
      queueMicrotask(() => listener.items([availability() as never]));

      return () => undefined;
    }

    if (kind !== "machines") return () => undefined;

    // SAFETY: only the machines feed is answered; its items are machine lists.
    return feed.listen((list) => listener.items([list as never]));
  },
  onAppEvent: () => () => undefined,
});

const sceneOf = (hash: string): Scene => {
  const name = hash.replace(/^#hosts\//, "");

  return SCENES.find((s) => s === name) ?? "all";
};

export const mountHostsPreview = (root: HTMLElement, hash: string) => {
  const scene = sceneOf(hash);
  const feed = createFeed(machinesFor(scene, Date.now()));
  const store = createStore<AppState>(() => ({ ...initialState, hosts: hostViews(feed.get()) }));

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: (density) => store.setState({ density }),
    setAppearance: ({ density, theme }) => store.setState({ density, theme }),
  };

  const navigation = createNavigation({ app: store, storage: null });

  standInBridge(bridgeFor(feed, scene));
  setResourcesClient(fakeResources);
  navigation.actions.openSettings("hosts");

  const commands = createCommandRegistry({ platform: "mac" });

  createRoot(root).render(<App value={{ connection, navigation, commands }} />);

  return connection.setDensity;
};
