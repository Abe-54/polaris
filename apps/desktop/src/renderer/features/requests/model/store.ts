/**
 * Each Agent Session's Requests view, kept while the user moves around: the open Request, unsaved
 * drafts, the environment, the request pane's tab, closed file groups, and the latest send.
 */
import type { Send } from "@polaris/protocol";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { Draft } from "./draft.ts";
import { type RequestsSessionKey, sessionString } from "./session.ts";

export type RequestTab = "params" | "headers" | "body" | "auth";

export type SidebarView = "requests" | "send-log";

export interface RequestsView {
  /** A saved Request's `refString`, or a `new:` key for one not in a file yet. */
  readonly open: string | null;
  /** Edited Requests by key; a saved Request without one shows the file's. */
  readonly drafts: Readonly<Record<string, Draft>>;
  /** Null until picked: the snapshot's first environment then. */
  readonly environment: string | null;
  readonly tab: RequestTab;
  readonly sidebar: SidebarView;
  /** File groups the user closed. */
  readonly closed: Readonly<Record<string, true>>;
  /** The latest send from this view, for the send pane. */
  readonly latest: Send | null;
  readonly sending: boolean;
}

const EMPTY: RequestsView = {
  open: null,
  drafts: {},
  environment: null,
  tab: "body",
  sidebar: "requests",
  closed: {},
  latest: null,
  sending: false,
};

const store = createStore<Readonly<Record<string, RequestsView>>>(() => ({}));

const read = (at: RequestsSessionKey) => store.getState()[sessionString(at)] ?? EMPTY;

const update = (at: RequestsSessionKey, change: (view: RequestsView) => Partial<RequestsView>) =>
  store.setState((s) => {
    const key = sessionString(at);
    const view = s[key] ?? EMPTY;

    return { ...s, [key]: { ...view, ...change(view) } };
  });

export const requestsView = read;

/** Forgets the session's view: its drafts, open Request and latest send. */
export const clearRequestsView = (at: RequestsSessionKey) =>
  store.setState((s) => {
    const { [sessionString(at)]: _gone, ...rest } = s;

    return rest;
  });

export const useRequestsView = (at: RequestsSessionKey): RequestsView =>
  useStore(store, (s) => s[sessionString(at)] ?? EMPTY);

export const openRequest = (at: RequestsSessionKey, key: string | null) =>
  update(at, () => ({ open: key }));

export const setDraft = (at: RequestsSessionKey, key: string, draft: Draft) =>
  update(at, (view) => ({ drafts: { ...view.drafts, [key]: draft } }));

/** Forgets a draft; `moveTo` reopens what was open under the key it was saved as. */
export const dropDraft = (at: RequestsSessionKey, key: string, moveTo?: string) =>
  update(at, (view) => {
    const { [key]: _gone, ...drafts } = view.drafts;

    return { drafts, open: view.open === key && moveTo !== undefined ? moveTo : view.open };
  });

let next = 0;

/** Opens a Request that isn't in a file yet; its key is new each time. */
export const openNewDraft = (at: RequestsSessionKey, draft: Draft) => {
  const key = `new:${++next}`;

  update(at, (view) => ({ drafts: { ...view.drafts, [key]: draft }, open: key }));

  return key;
};

export const setEnvironment = (at: RequestsSessionKey, environment: string) =>
  update(at, () => ({ environment }));

export const setRequestTab = (at: RequestsSessionKey, tab: RequestTab) =>
  update(at, () => ({ tab }));

export const setSidebarView = (at: RequestsSessionKey, sidebar: SidebarView) =>
  update(at, () => ({ sidebar }));

export const toggleFile = (at: RequestsSessionKey, path: string) =>
  update(at, (view) => {
    const { [path]: wasClosed, ...rest } = view.closed;

    return { closed: wasClosed === true ? rest : { ...rest, [path]: true } };
  });

export const setSending = (at: RequestsSessionKey, sending: boolean) =>
  update(at, () => ({ sending }));

export const setLatestSend = (at: RequestsSessionKey, latest: Send) =>
  update(at, () => ({ latest, sending: false }));
