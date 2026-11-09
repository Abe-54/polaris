/**
 * The send log tab's own state per Agent Session, kept across the tab switch: its filter and the
 * selected Send. Opening a Send shows its Request (or, for an ad-hoc Send, a new draft as it was
 * sent) in the request pane and the Send itself in the send pane.
 */
import type { AdHocRequest, Send } from "@polaris/protocol";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { draftFromAdHoc, refString } from "./draft.ts";
import { type RequestsSessionKey, sessionString } from "./session.ts";
import { openNewDraft, openRequest, setEnvironment, setLatestSend } from "./store.ts";

interface SendLogView {
  readonly filter: string;
  readonly selected: string | null;
}

const EMPTY: SendLogView = { filter: "", selected: null };

const store = createStore<Readonly<Record<string, SendLogView>>>(() => ({}));

const update = (at: RequestsSessionKey, change: Partial<SendLogView>) =>
  store.setState((s) => {
    const key = sessionString(at);

    return { ...s, [key]: { ...(s[key] ?? EMPTY), ...change } };
  });

export const useSendLogView = (at: RequestsSessionKey): SendLogView =>
  useStore(store, (s) => s[sessionString(at)] ?? EMPTY);

/** Forgets the session's filter and selected Send. */
export const clearSendLogView = (at: RequestsSessionKey) =>
  store.setState((s) => {
    const { [sessionString(at)]: _gone, ...rest } = s;

    return rest;
  }, true);

export const setSendLogFilter = (at: RequestsSessionKey, filter: string) => update(at, { filter });

type Mutable<A> = { -readonly [K in keyof A]: A[K] };

/** The Send's Request as it went out; its headers and URL already have secrets masked. */
const adHocOf = (send: Send): AdHocRequest => {
  const request: Mutable<AdHocRequest> = {
    method: send.method,
    url: send.url,
    headers: send.requestHeaders,
  };

  if (send.requestBody !== undefined) request.body = send.requestBody;

  return request;
};

export const openSend = (at: RequestsSessionKey, send: Send, taken: ReadonlySet<string>) => {
  if (send.environment !== undefined) setEnvironment(at, send.environment);

  if (send.requestRef === null) openNewDraft(at, draftFromAdHoc(adHocOf(send), taken));
  else openRequest(at, refString(send.requestRef));
  setLatestSend(at, send);
  update(at, { selected: send.id });
};
