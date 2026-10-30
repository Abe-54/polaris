/**
 * The app's navigation: a stack of screens over the tabs (Sessions, Review, Settings) and New.
 * Screens push routes; the shell in App.tsx draws the top of the stack.
 */
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { Platform, Settings } from "react-native";

import {
  type HomeTab,
  initialNavigation,
  type Layer,
  layersOf,
  type NavigationState,
  opened,
  pushed,
  replaced,
  selected,
  topOf,
  wentBack,
} from "./navigationState.ts";
import type { Route } from "./route.ts";

export type { HomeTab, Layer, Route };

export interface Navigation {
  readonly top: Route;
  /** The top screen and the one beneath it, which a swipe back uncovers. */
  readonly layers: ReadonlyArray<Layer>;
  readonly tab: HomeTab;
  readonly selectTab: (tab: HomeTab) => void;
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

  if (value === "hosts") return pushed(initialNavigation, { screen: "hosts" });

  if (value === "review" || value === "settings") return selected(initialNavigation, value);

  return initialNavigation;
};

export const NavigationProvider = ({ children }: { readonly children: ReactNode }) => {
  const [state, setState] = useState<NavigationState>(launchedNavigation);

  const open = useCallback((route: Route) => setState((current) => opened(current, route)), []);

  const navigation = useMemo<Navigation>(
    () => ({
      top: topOf(state),
      layers: layersOf(state),
      tab: state.tab,
      selectTab: (tab) => setState((current) => selected(current, tab)),
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
