/**
 * The app's navigation: a stack of screens over the tabs (Sessions, Review, Settings) and New.
 * Screens push routes; the shell in App.tsx draws the top of the stack.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from "react";
import { BackHandler, Platform, Settings } from "react-native";

import {
  type HomeTab,
  hostsClosed,
  hostsOpened,
  initialNavigation,
  type Layer,
  layersOf,
  type NavigationState,
  opened,
  pushed,
  replaced,
  selected,
  topOf,
  type SettingsRoute,
  wentBack,
} from "./navigationState.ts";
import type { Route } from "./route.ts";

export type { HomeTab, Layer, Route, SettingsRoute };

export interface Navigation {
  readonly top: Route;
  /** The top screen and the one beneath it, which a swipe back uncovers. */
  readonly layers: ReadonlyArray<Layer>;
  readonly tab: HomeTab;
  /** What the Settings tab shows: Settings, or Hosts under it. */
  readonly settings: SettingsRoute;
  readonly selectTab: (tab: HomeTab) => void;
  /** Hosts on the Settings tab, from anywhere; `closeHosts` returns to Settings. */
  readonly openHosts: () => void;
  readonly closeHosts: () => void;
  readonly push: (route: Route) => void;
  /** Swaps the top screen for `route`. */
  readonly replace: (route: Route) => void;
  readonly back: () => void;
  /** Opens a route from outside the app (a widget's link): Home, or the route on top of it. */
  readonly open: (route: Route) => void;
  /** Opens a new agent session; `workspaceId` preselects one. */
  readonly openNewSession: (workspaceId?: string) => void;
}

const NavigationContext = createContext<Navigation | null>(null);

/** A development build's `-polarisDevRoute hosts|review|settings`: where it opens, for screenshots. */
const launchedNavigation = (): NavigationState => {
  const value: unknown = __DEV__ && Platform.OS === "ios" ? Settings.get("polarisDevRoute") : null;

  if (value === "hosts") return hostsOpened(initialNavigation);

  if (value === "review" || value === "settings") return selected(initialNavigation, value);

  return initialNavigation;
};

export const NavigationProvider = ({ children }: { readonly children: ReactNode }) => {
  const [state, setState] = useState<NavigationState>(launchedNavigation);

  // Registered once, so a sheet that opens later still hears Back first; it reads the latest state.
  const back = useEffectEvent(() => {
    if (state.stack.length <= 1) return false;
    setState(wentBack);

    return true;
  });

  useEffect(() => {
    if (Platform.OS !== "android") return;

    const subscription = BackHandler.addEventListener("hardwareBackPress", () => back());

    return () => subscription.remove();
  }, []);

  const open = useCallback((route: Route) => setState((current) => opened(current, route)), []);

  const navigation = useMemo<Navigation>(
    () => ({
      top: topOf(state),
      layers: layersOf(state),
      tab: state.tab,
      settings: state.settings,
      selectTab: (tab) => setState((current) => selected(current, tab)),
      openHosts: () => setState(hostsOpened),
      closeHosts: () => setState(hostsClosed),
      push: (route) => setState((current) => pushed(current, route)),
      replace: (route) => setState((current) => replaced(current, route)),
      back: () => setState(wentBack),
      open,
      openNewSession: (workspaceId) =>
        setState((current) =>
          pushed(current, { screen: "newSession", workspaceId: workspaceId ?? null })
        ),
    }),
    [state, open]
  );

  return <NavigationContext.Provider value={navigation}>{children}</NavigationContext.Provider>;
};

export const useNavigation = (): Navigation => {
  const navigation = useContext(NavigationContext);

  if (navigation === null) throw new Error("useNavigation needs a NavigationProvider above it");

  return navigation;
};
