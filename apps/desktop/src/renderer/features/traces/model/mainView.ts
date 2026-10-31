/**
 * Which view each Agent Session's Traces shows (Waterfall, Table or Service map), kept across
 * traces; the layout reads it to show the service panel in place of the span panel.
 */
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { TracesSessionKey } from "./session.ts";

export type MainView = "waterfall" | "table" | "map";

const store = createStore<Readonly<Record<string, MainView>>>(() => ({}));

const keyOf = (at: TracesSessionKey) => `${at.hostKey}\u0000${at.sessionId}`;

export const setMainView = (at: TracesSessionKey, view: MainView) =>
  store.setState((s) => ({ ...s, [keyOf(at)]: view }));

export const useMainView = (at: TracesSessionKey): MainView =>
  useStore(store, (s) => s[keyOf(at)] ?? "waterfall");
