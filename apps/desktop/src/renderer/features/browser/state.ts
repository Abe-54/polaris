/**
 * Each session's Browser in the renderer: its tabs as main reports them, whether the Browser is
 * the Output tab on screen, and the activity dot an agent's tab leaves when it isn't.
 */
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { BrowserTabEvent } from "../../../shared/browserContract.ts";
import { applyTabEvents, type BrowserTabs, NO_TABS } from "./model.ts";

export interface BrowserUi {
  readonly tabs: BrowserTabs;
  /** The Browser is the Output tab chosen for this session. */
  readonly shown: boolean;
  /** An agent opened a tab while the user was in another Output tab. */
  readonly dot: boolean;
}

const EMPTY: BrowserUi = { tabs: NO_TABS, shown: false, dot: false };

const store = createStore<Readonly<Record<string, BrowserUi>>>(() => ({}));

const patch = (key: string, change: (ui: BrowserUi) => Partial<BrowserUi>) =>
  store.setState((s) => {
    const current = s[key] ?? EMPTY;

    return { ...s, [key]: { ...current, ...change(current) } };
  });

export const useBrowserUi = (key: string): BrowserUi => useStore(store, (s) => s[key] ?? EMPTY);

export const browserUi = (key: string): BrowserUi => store.getState()[key] ?? EMPTY;

export const applyBrowserEvents = (key: string, events: ReadonlyArray<BrowserTabEvent>) =>
  patch(key, (ui) => ({ tabs: applyTabEvents(ui.tabs, events) }));

/** The Browser becomes (or stops being) the Output tab on screen; showing it clears its dot. */
export const setBrowserShown = (key: string, shown: boolean) =>
  patch(key, () => (shown ? { shown, dot: false } : { shown }));

export const markBrowserActivity = (key: string) => patch(key, () => ({ dot: true }));
