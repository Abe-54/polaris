/**
 * The session view's own UI state, per Agent Session: which Turns are open
 * (`model/conversation.ts`), which Turn Output shows, and the composer's draft. It outlives the
 * view, so switching back to a session paints it as it was left.
 */
import type { AttachmentId } from "@polaris/protocol";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { type Folds, noFolds } from "./model/conversation.ts";
import type { Outgoing } from "./model/outbox.ts";

export interface StagedAttachment {
  readonly id: AttachmentId;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  /** Where the Host staged it, and an image's size: what a pending message previews from. */
  readonly hostPath: string;
  readonly width: number | null;
  readonly height: number | null;
  /** Set on the files of an element picked in the Browser: they show as one chip (ENG-618). */
  readonly pick?: PickedElement;
}

export interface PickedElement {
  /** Shared by the pick's screenshot and its note. */
  readonly key: string;
  readonly selector: string;
  readonly url: string;
  readonly html: string;
}

export interface SessionUi {
  readonly folds: Folds;
  /** The Turn whose diff Output shows; null follows the latest Turn. */
  readonly diffTurnId: string | null;
  /** The Subagent Output's Subagent tab shows; null shows Changes (or a Lead's tab). */
  readonly subagentId: string | null;
  readonly draft: string;
  readonly attachments: ReadonlyArray<StagedAttachment>;
  /** Steers and queued follow-ups (⌘↵) not in the conversation yet (`model/outbox.ts`). */
  readonly outbox: ReadonlyArray<Outgoing<StagedAttachment>>;
}

const EMPTY: SessionUi = {
  folds: noFolds,
  diffTurnId: null,
  subagentId: null,
  draft: "",
  attachments: [],
  outbox: [],
};

type UiState = Readonly<Record<string, SessionUi>>;

const store = createStore<UiState>(() => ({}));

export const uiKey = (hostKey: string, sessionId: string) => `${hostKey}\u0000${sessionId}`;

export const useSessionUi = (key: string): SessionUi => useStore(store, (s) => s[key] ?? EMPTY);

export const patchSessionUi = (key: string, patch: (ui: SessionUi) => Partial<SessionUi>) =>
  store.setState((s) => {
    const current = s[key] ?? EMPTY;

    return { ...s, [key]: { ...current, ...patch(current) } };
  });

/** The user opens or folds one Turn; it stays that way whatever arrives after it. */
export const setTurnOpen = (key: string, turnId: string, open: boolean) =>
  patchSessionUi(key, ({ folds }) => ({
    folds: { ...folds, chosen: new Map(folds.chosen).set(turnId, open) },
  }));

/** Marks the latest Turn when the session is first shown: it and every later Turn start open. */
export const holdOpenFrom = (key: string, turnId: string) =>
  patchSessionUi(key, ({ folds }) =>
    folds.openFrom === null ? { folds: { ...folds, openFrom: turnId } } : {}
  );

export const showTurnDiff = (key: string, turnId: string | null) =>
  patchSessionUi(key, () => ({ diffTurnId: turnId }));

export const showSubagent = (key: string, subagentId: string | null) =>
  patchSessionUi(key, () => ({ subagentId }));

/** Change one outbox entry; a no-op once it's gone. */
export const patchOutgoing = (
  key: string,
  id: string,
  patch: (entry: Outgoing<StagedAttachment>) => Partial<Outgoing<StagedAttachment>>
) =>
  patchSessionUi(key, ({ outbox }) => ({
    outbox: outbox.map((e) => (e.id === id ? { ...e, ...patch(e) } : e)),
  }));

export const dropOutgoing = (key: string, id: string) =>
  patchSessionUi(key, ({ outbox }) => ({ outbox: outbox.filter((e) => e.id !== id) }));

/** Changes a session's composer draft from outside the view (⌘L in the editor adds a source). */
export const updateDraft = (
  hostKey: string,
  sessionId: string,
  update: (draft: string) => string
) => patchSessionUi(uiKey(hostKey, sessionId), ({ draft }) => ({ draft: update(draft) }));

/** Calls `listener` with each session whose draft changed, by its `uiKey`. */
export const onDraftChange = (listener: (key: string, draft: string) => void) =>
  store.subscribe((next, prev) => {
    for (const [key, ui] of Object.entries(next))
      if (ui.draft !== (prev[key]?.draft ?? "")) listener(key, ui.draft);
  });
