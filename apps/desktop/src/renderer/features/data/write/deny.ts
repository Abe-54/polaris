/**
 * A write approval's Deny, shared by every view of it: the reason field open or not and its draft,
 * so Deny from the inbox, a notification or ⌘⇧D opens the card's field instead of denying blind.
 */
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

interface DenyState {
  readonly open: boolean;
  readonly draft: string;
  /** Bumped by each ask from elsewhere, so the shown card focuses its field again. */
  readonly asked: number;
}

const CLOSED: DenyState = { open: false, draft: "", asked: 0 };

export const denyStore = createStore<Readonly<Record<string, DenyState>>>(() => ({}));

const patch = (requestId: string, change: (state: DenyState) => DenyState) =>
  denyStore.setState((s) => ({ [requestId]: change(s[requestId] ?? CLOSED) }));

export const useDeny = (requestId: string): DenyState =>
  useStore(denyStore, (s) => s[requestId] ?? CLOSED);

export const openDeny = (requestId: string) => patch(requestId, (s) => ({ ...s, open: true }));

export const closeDeny = (requestId: string) => patch(requestId, (s) => ({ ...s, open: false }));

export const setDenyDraft = (requestId: string, draft: string) =>
  patch(requestId, (s) => ({ ...s, draft }));

/** Deny asked outside the card: its field opens and takes focus wherever the card shows. */
export const askDenyReason = (requestId: string) =>
  patch(requestId, (s) => ({ ...s, open: true, asked: s.asked + 1 }));
