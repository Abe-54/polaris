/** React access to the app: the store and navigation in context, slices through selectors. */
import type { SessionId } from "@polaris/protocol";
import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import type { CommandRegistry } from "../routes/commands.ts";
import type { Navigation, ShellActions } from "../routes/navigation.ts";
import type { NavState, Selection } from "../routes/selection.ts";
import type { AppState, Connection } from "../store/store.ts";

export interface AppContextValue {
  readonly connection: Connection;
  readonly navigation: Navigation;
  readonly commands: CommandRegistry;
}

const AppContext = createContext<AppContextValue | null>(null);

export const AppProvider = AppContext.Provider;

const useAppContext = (): AppContextValue => {
  const value = useContext(AppContext);

  if (value === null) throw new Error("used outside AppProvider");

  return value;
};

export const useConnection = (): Connection => useAppContext().connection;

/** Re-renders only when the selected slice changes (by `Object.is`). */
export const useApp = <A>(select: (state: AppState) => A): A =>
  useStore(useConnection().store, select);

export const useNav = <A>(select: (state: NavState) => A): A =>
  useStore(useAppContext().navigation.store, select);

export const useShellActions = (): ShellActions => useAppContext().navigation.actions;

/** Navigation itself, for reading the selection at the moment of an action without re-rendering. */
export const useNavigation = (): Navigation => useAppContext().navigation;

/** The command registry: run a command by id, or register handlers while mounted. */
export const useCommands = (): CommandRegistry => useAppContext().commands;

/** The current selection, resolved against the data; stable until it changes. */
export const useSelection = (): Selection => {
  const { connection, navigation } = useAppContext();

  return useSyncExternalStore((onChange) => {
    const offApp = connection.store.subscribe(onChange);
    const offNav = navigation.store.subscribe(onChange);

    return () => {
      offApp();
      offNav();
    };
  }, navigation.current);
};

/** Keeps an Agent Session's feed open while the component is mounted. */
export const useSessionFeed = (hostKey: string, sessionId: SessionId | null) => {
  const { openSession } = useConnection();

  useEffect(() => {
    return sessionId === null ? undefined : openSession(hostKey, sessionId);
  }, [openSession, hostKey, sessionId]);
};
