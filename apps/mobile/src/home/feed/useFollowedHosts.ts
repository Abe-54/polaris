/**
 * Every Host's Connection State and followed feed as React state, for Home, Hosts, the Review
 * tab and its badge, a new agent session and the widgets. One feed per Host for the
 * app's life, shared by every reader; it waits out Reconnecting and Offline.
 */
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { useHosts } from "../../runtime/hosts.tsx";
import type { HomeHost } from "../model/home.ts";
import {
  type FollowedHostState,
  type FollowedHostsStore,
  followedHostsStore,
} from "./followedHosts.ts";

export type { FollowedHostState } from "./followedHosts.ts";

const FollowedHosts = createContext<FollowedHostsStore | null>(null);

/** Follows every Host once, under the screens, so leaving Home doesn't drop the feeds. */
export const FollowedHostsProvider = ({ children }: { readonly children: ReactNode }) => {
  const connections = useHosts();
  const [store] = useState(followedHostsStore);

  useEffect(() => {
    store.follow(connections);
  }, [store, connections]);
  useEffect(() => () => store.follow([]), [store]);

  return createElement(FollowedHosts.Provider, { value: store }, children);
};

export const useFollowedHosts = (): ReadonlyArray<FollowedHostState> => {
  const store = useContext(FollowedHosts);

  if (store === null) throw new Error("useFollowedHosts needs a FollowedHostsProvider above it");

  return useSyncExternalStore(store.subscribe, store.snapshot);
};

/** The followed Hosts as Home's model reads them, named by their hostname once it is known. */
export const homeHostsOf = (hosts: ReadonlyArray<FollowedHostState>): ReadonlyArray<HomeHost> =>
  hosts.map(({ connection, status, followed }) => ({
    hostId: connection.hostId,
    name: status.host?.hostname ?? connection.name,
    connection: status.state,
    followed,
    failure: status.failure?.detail ?? null,
  }));
