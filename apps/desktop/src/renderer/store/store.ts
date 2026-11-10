/**
 * The renderer's store: the Host list with Connection States, each Host's read
 * model, and the open Agent Sessions. A zustand vanilla store, so feeds write
 * to it outside React and components read slices with `useSyncExternalStore`
 * selectors; updates land once per frame (see frameQueue.ts).
 */
import type { HostStreamItem, SessionId, SessionStreamItem } from "@polaris/protocol";
import { createStore, type StoreApi } from "zustand/vanilla";
import type {
  Appearance,
  CachedHost,
  Density,
  HostView,
  PolarisApi,
  ThemeSource,
} from "../../shared/api.ts";
import { frameQueue } from "./frameQueue.ts";
import { noteHostKinds } from "./hostKinds.ts";
import { applyHostItems, emptyHostModel, type HostModel, modelFromSnapshot } from "./hostModel.ts";
import { applySessionItems, emptySessionModel, type SessionModel } from "./sessionModel.ts";
import {
  applyConstellationHostItems,
  type ConstellationsModel,
  emptyConstellations,
} from "../features/constellation/model/index.ts";

export interface AppState {
  readonly hosts: ReadonlyArray<HostView>;
  /** False until main first lists the Hosts, so "none yet" isn't read as "none at all". */
  readonly hostsListed: boolean;
  readonly hostModels: Readonly<Record<string, HostModel>>;
  /** Keyed by `sessionKey(hostKey, sessionId)`. */
  readonly sessions: Readonly<Record<string, SessionModel>>;
  /** The density step, for the few sizes that are numbers rather than CSS tokens (tiles). */
  readonly density: Density;
  /** The theme setting ("system" follows macOS); the jump menu's toggle reads it. */
  readonly theme: ThemeSource;
  /** Each Host's Constellations, folded from its feed (features/constellation). */
  readonly constellations: Readonly<Record<string, ConstellationsModel>>;
}

export const initialState: AppState = {
  hosts: [],
  hostsListed: false,
  hostModels: {},
  sessions: {},
  density: "calm",
  theme: "system",
  constellations: {},
};

export const sessionKey = (hostKey: string, sessionId: string) => `${hostKey}\u0000${sessionId}`;

/** The Host this Client calls `hostKey` for a Daemon's `hostId`, once it has connected. */
export const hostKeyOf = (hosts: ReadonlyArray<HostView>, hostId: string): string | null =>
  hosts.find((h) => h.status.host?.hostId === hostId)?.key ?? null;

type Update =
  | { readonly kind: "hosts"; readonly hosts: ReadonlyArray<HostView> }
  | { readonly kind: "host"; readonly hostKey: string; readonly item: HostStreamItem }
  | { readonly kind: "session"; readonly key: string; readonly item: SessionStreamItem };

const groupBy = <A>(items: ReadonlyArray<A>, key: (a: A) => string) => {
  const groups = new Map<string, Array<A>>();

  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);

    if (group === undefined) groups.set(k, [item]);
    else group.push(item);
  }

  return groups;
};

interface GroupFold<M, I> {
  readonly current: Readonly<Record<string, M>>;
  readonly groups: ReadonlyMap<string, ReadonlyArray<I>>;
  readonly apply: (model: M | undefined, group: ReadonlyArray<I>) => M;
}

/** A new record with each group folded in; the same record when there is nothing to fold. */
const foldGroups = <M, I>({ current, groups, apply }: GroupFold<M, I>) => {
  if (groups.size === 0) return current;
  const folded = [...groups].map(([key, group]): [string, M] => [key, apply(current[key], group)]);

  return { ...current, ...Object.fromEntries(folded) };
};

/** Folds one frame's updates into the state; pure, so it is unit-tested. */
export const reduceUpdates = (state: AppState, updates: ReadonlyArray<Update>): AppState => {
  let hosts = state.hosts;
  let hostsListed = state.hostsListed;
  const hostItems: Array<{ hostKey: string; item: HostStreamItem }> = [];
  const sessionItems: Array<{ key: string; item: SessionStreamItem }> = [];

  for (const u of updates) {
    if (u.kind === "hosts") {
      hosts = u.hosts;
      hostsListed = true;
    } else if (u.kind === "host") hostItems.push(u);
    else sessionItems.push(u);
  }

  // Only copy what changed: a frame of deltas must not re-render Host-level views.
  const hostModels = foldGroups({
    current: state.hostModels,
    groups: groupBy(hostItems, (h) => h.hostKey),
    apply: (model, group) =>
      applyHostItems(
        model ?? emptyHostModel,
        group.map((g) => g.item)
      ),
  });

  const constellations = foldGroups({
    current: state.constellations,
    groups: groupBy(hostItems, (h) => h.hostKey),
    apply: (model, group) =>
      applyConstellationHostItems(
        model ?? emptyConstellations,
        group.map((g) => g.item)
      ),
  });

  const sessions = foldGroups({
    current: state.sessions,
    groups: groupBy(sessionItems, (s) => s.key),
    apply: (model, group) =>
      applySessionItems(
        model ?? emptySessionModel,
        group.map((g) => g.item)
      ),
  });

  return { ...state, hosts, hostsListed, hostModels, sessions, constellations };
};

/** A Host model painted from the cache, marked so, until its live Snapshot arrives. */
export const cachedModel = (cached: CachedHost): HostModel => ({
  ...modelFromSnapshot(cached),
  fromCache: true,
});

/** Snapshot of a synchronized model for the cache; null while it is still from the cache. */
export const toCached = (hostKey: string, model: HostModel): CachedHost | null => {
  if (!model.synchronized || model.fromCache) return null;

  return {
    hostKey,
    sequence: model.sequence,
    workspaces: [...model.workspaces.values()],
    worktrees: [...model.worktrees.values()],
    sessions: [...model.sessions.values()],
  };
};

export type AppStore = StoreApi<AppState>;

/** How long a changed Host waits before its put; leaving the window or quitting puts it sooner. */
export const CACHE_WRITE_DELAY_MS = 30_000;

export interface CacheWrites {
  /** A Host's model changed: put it within the delay, unless one is already waiting. */
  readonly changed: (hostKey: string) => void;
  /** Puts every waiting Host now; resolves once main has them. */
  readonly flush: () => Promise<void>;
}

/** At most one put per Host per delay, each with that Host's model at the time it is sent. */
export const cacheWrites = ({
  model,
  put,
  delayMs = CACHE_WRITE_DELAY_MS,
}: {
  readonly model: (hostKey: string) => HostModel;
  readonly put: (host: CachedHost) => Promise<void>;
  readonly delayMs?: number;
}): CacheWrites => {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const sending = new Set<Promise<void>>();

  const write = (hostKey: string) => {
    clearTimeout(timers.get(hostKey));
    timers.delete(hostKey);
    const host = toCached(hostKey, model(hostKey));

    if (host === null) return;
    const sent = put(host).finally(() => sending.delete(sent));

    sending.add(sent);
  };

  return {
    changed: (hostKey) => {
      if (!timers.has(hostKey))
        timers.set(
          hostKey,
          setTimeout(() => write(hostKey), delayMs)
        );
    },
    flush: async () => {
      for (const hostKey of timers.keys()) write(hostKey);
      await Promise.allSettled(sending);
    },
  };
};

export interface Connection {
  readonly store: AppStore;
  /** Opens (or shares) an Agent Session's feed; call the returned function to release it. */
  readonly openSession: (hostKey: string, sessionId: SessionId) => () => void;
  readonly setAppearance: (appearance: Appearance) => void;
  readonly setDensity: (density: Density) => void;
}

/** Connects a store to the main process: the Host list, every Host's feed, and the cache. */
export const connect = (api: PolarisApi): Connection => {
  const store = createStore<AppState>(() => initialState);

  const queue = frameQueue<Update>({
    apply: (updates) => store.setState((state) => reduceUpdates(state, updates), true),
  });

  const hostFeeds = new Set<string>();
  const sessionFeeds = new Map<string, { refs: number; close: () => void }>();

  const cache = cacheWrites({
    model: (hostKey) => store.getState().hostModels[hostKey] ?? emptyHostModel,
    put: async (host) => {
      await api.request("cache.put", { host });
    },
  });

  void api.request("cache.get", {}).then((result) => {
    if (!result.ok) return;
    store.setState((state) => {
      const hostModels = { ...state.hostModels };

      for (const cached of result.value) hostModels[cached.hostKey] ??= cachedModel(cached);

      return { ...state, hostModels };
    });
  });

  const openHost = (hostKey: string) => {
    if (hostFeeds.has(hostKey)) return;
    hostFeeds.add(hostKey);
    api.subscribe(
      "host",
      { hostKey },
      {
        items: (items) => {
          for (const item of items) queue.push({ kind: "host", hostKey, item });
        },
        end: () => hostFeeds.delete(hostKey),
      }
    );
  };

  api.subscribe(
    "hosts",
    {},
    {
      items: (lists) => {
        const hosts = lists.at(-1);

        if (hosts === undefined) return;
        noteHostKinds(hosts);
        queue.push({ kind: "hosts", hosts });

        for (const host of hosts) openHost(host.key);
      },
    }
  );

  store.subscribe((state, previous) => {
    for (const [hostKey, model] of Object.entries(state.hostModels))
      if (model !== previous.hostModels[hostKey]) cache.changed(hostKey);
  });

  api.onAppEvent((event) => {
    if (event.kind !== "cache-flush") return;
    void cache.flush().then(() => api.request("cache.flushed", { id: event.id }));
  });

  const openSession = (hostKey: string, sessionId: SessionId) => {
    const key = sessionKey(hostKey, sessionId);
    const existing = sessionFeeds.get(key);

    if (existing !== undefined) existing.refs++;
    else {
      const close = api.subscribe(
        "session",
        { hostKey, sessionId, turnLimit: 20 },
        { items: (items) => items.forEach((item) => queue.push({ kind: "session", key, item })) }
      );

      sessionFeeds.set(key, { refs: 1, close });
    }

    return () => {
      const feed = sessionFeeds.get(key);

      if (feed === undefined || --feed.refs > 0) return;
      sessionFeeds.delete(key);
      feed.close();
    };
  };

  return {
    store,
    openSession,
    setAppearance: ({ density, theme }) => store.setState({ density, theme }),
    setDensity: (density) => store.setState({ density }),
  };
};
