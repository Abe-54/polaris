/** The navigation's state and its moves, pure, so the shell and its tests share them. */
import type { Route } from "./route.ts";

/** The tabs under the stack, in the pill's order; Hosts is a pushed screen, reached from Settings. */
export const HOME_TABS = ["sessions", "review", "settings"] as const;

export type HomeTab = (typeof HOME_TABS)[number];

export interface NavigationState {
  readonly stack: ReadonlyArray<Route>;
  readonly tab: HomeTab;
}

const HOME: Route = { screen: "tabs" };

export const initialNavigation: NavigationState = {
  stack: [HOME],
  tab: "sessions",
};

export const topOf = (state: NavigationState): Route => state.stack.at(-1) ?? HOME;

/** A screen drawn by the shell, keyed by its place on the stack so it keeps its state as it moves. */
export interface Layer {
  readonly route: Route;
  readonly index: number;
}

/** The top of the stack and the screen beneath it, bottom first: a swipe back uncovers the second. */
export const layersOf = (state: NavigationState): ReadonlyArray<Layer> =>
  state.stack.map((route, index) => ({ route, index })).slice(-2);

export const pushed = (state: NavigationState, route: Route): NavigationState => ({
  ...state,
  stack: [...state.stack, route],
});

export const selected = (state: NavigationState, tab: HomeTab): NavigationState => ({
  ...state,
  tab,
});

/** The top screen swapped for `route`: a new session becomes its thread once it starts. */
export const replaced = (state: NavigationState, route: Route): NavigationState => ({
  ...state,
  stack: state.stack.length > 1 ? [...state.stack.slice(0, -1), route] : [...state.stack, route],
});

export const wentBack = (state: NavigationState): NavigationState =>
  state.stack.length > 1 ? { ...state, stack: state.stack.slice(0, -1) } : state;

/** A link from outside the app lands on Home's Sessions, or on its route above it. */
export const opened = (state: NavigationState, route: Route): NavigationState => ({
  stack: route.screen === "tabs" ? [route] : [HOME, route],
  tab: "sessions",
});
