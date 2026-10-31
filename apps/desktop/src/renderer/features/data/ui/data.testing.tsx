/** The sidebar and connection bar on a fixture `DataApi`, as Data mode lays them out, for tests. */
import "../../../test/dom.testing.ts";
import type { ConnectionState } from "@polaris/protocol";
import { TooltipProvider } from "@polaris/ui";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "bun:test";
import { createStore } from "zustand/vanilla";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, type Connection, initialState } from "../../../store/store.ts";
import type { DataApi, Snapshots } from "../data/api.ts";
import { DataLayer } from "../data/hooks.tsx";
import { closeSourceForm, sidebarStore } from "../model/sidebar.ts";
import { type DataSessionKey, dataTabsStore, useDataTabs } from "../model/store.ts";
import type { DataTabs } from "../model/tabs.ts";
import { DATA_AT, DATA_WORKSPACE_ID, dataHost, dataHostModel } from "../preview/scene.ts";
import { ConnectionBar } from "./ConnectionBar.tsx";
import { DataSidebar } from "./Sidebar.tsx";

const KEYS = ["offsetWidth", "offsetHeight"] as const;

/** happy-dom has no layout: lists get a tall viewport, and each virtualized row a tree row's height. */
function size(this: HTMLElement, key: (typeof KEYS)[number]) {
  if (key === "offsetWidth") return 270;

  return this.hasAttribute("data-index") ? 28 : 2000;
}

/** Installs the fake layout for the file's tests and resets the tab store after each. */
export const useDataLayout = () => {
  const saved = KEYS.map(
    (key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)] as const
  );

  beforeAll(() => {
    for (const key of KEYS)
      Object.defineProperty(HTMLElement.prototype, key, {
        configurable: true,
        get(this: HTMLElement) {
          return size.call(this, key);
        },
      });
  });

  afterAll(() => {
    for (const [key, descriptor] of saved)
      if (descriptor !== undefined) Object.defineProperty(HTMLElement.prototype, key, descriptor);
  });

  afterEach(() => {
    cleanup();
    dataTabsStore.setState({ sessions: {}, shown: null });
    closeSourceForm(DATA_AT);
    sidebarStore.setState({}, true);
  });
};

export const page = () => within(document.body);

let refreshes = 0;

/** A time a day past the last one any test used, so refreshSources' throttle never holds it back. */
export const refreshTime = () => {
  refreshes += 1;

  return Date.now() + refreshes * 86_400_000;
};

interface ShownTabs {
  current: DataTabs | null;
}

/** The tabs of the shown session, read through the real store. */
export const shownTabs: ShownTabs = { current: null };

const TabsProbe = ({ at }: { readonly at: DataSessionKey }) => {
  shownTabs.current = useDataTabs(at);

  return null;
};

const Layout = ({ at }: { readonly at: DataSessionKey }) => {
  const shown = useDataTabs(at);
  const active = shown.tabs.find((t) => t.id === shown.active) ?? null;
  const props = { at, hostKey: at.hostKey, workspaceId: DATA_WORKSPACE_ID, active };

  return (
    <>
      <DataSidebar {...props} />
      <ConnectionBar {...props} />
      <TabsProbe at={at} />
    </>
  );
};

export const mountData = (
  api: DataApi,
  { state = "connected", at = DATA_AT }: { state?: ConnectionState; at?: DataSessionKey } = {}
) => {
  const store = createStore<AppState>(() => ({
    ...initialState,
    hosts: [dataHost(state)],
    hostModels: { [DATA_AT.hostKey]: dataHostModel() },
  }));

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  const navigation = createNavigation({ app: store, storage: null });
  const commands = createCommandRegistry({ platform: "mac" });

  return render(
    <AppProvider value={{ connection, navigation, commands }}>
      <TooltipProvider>
        <DataLayer api={api}>
          <Layout at={at} />
        </DataLayer>
      </TooltipProvider>
    </AppProvider>
  );
};

/** What a query or lookup found, or a failure naming what was missing. */
export const found = <A,>(value: A | null | undefined, what: string): A => {
  if (value === null || value === undefined) throw new Error(`No ${what}`);

  return value;
};

/** The element as an input, or a failure saying what it was instead. */
export const inputOf = (el: Element): HTMLInputElement => {
  if (!(el instanceof HTMLInputElement)) throw new Error(`Not an input: ${el.tagName}`);

  return el;
};

/** The focused element's data attributes; none when nothing is focused. */
export const focusedData = (): DOMStringMap =>
  document.activeElement instanceof HTMLElement ? document.activeElement.dataset : {};

export const click = (el: Element) =>
  act(() => {
    fireEvent.click(el);
  });

export const type = (el: Element, value: string) =>
  act(() => {
    fireEvent.change(el, { target: { value } });
  });

/** A watch that reports its first snapshot, so a test waits for the feed instead of a timer. */
export const delivered = <A,>(watch: (at: DataSessionKey, on: Snapshots<A>) => () => void) => {
  let done: () => void = () => undefined;

  const first = new Promise<void>((resolve) => {
    done = resolve;
  });

  const wrapped = (at: DataSessionKey, on: Snapshots<A>) =>
    watch(at, {
      ...on,
      next: (snapshot) => {
        on.next(snapshot);
        done();
      },
    });

  return { watch: wrapped, first };
};
