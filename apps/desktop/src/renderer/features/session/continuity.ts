/**
 * Continuity with the Host (ENG-458): the composer's draft is saved to the
 * Host as it's typed and restored from it, and the last ended Turn shown here
 * becomes the session's read position on every Client. One `continuity` feed
 * per Host while any of its sessions is open.
 */
import { type DraftStatus, type DraftSync, makeDraftSync } from "@polaris/client/continuity";
import { ContinuityItem, SessionId, type TurnId } from "@polaris/protocol";
import { useEffect } from "react";
import { polaris } from "../bridge.ts";
import { onDraftChange, patchSessionUi, uiKey } from "./state.ts";

interface Held {
  refs: number;
  close: () => void;
}

const hosts = new Map<string, Held>();

/** Each Host's draft sync outlives its feed, so typing a failed write left is written later. */
const syncs = new Map<string, DraftSync>();

/** A feed that ended while still held (its connection dropped) opens again after this. */
const REOPEN_MS = 1_000;

/** Set while a Host's draft is put into the composer, so it isn't written straight back. */
let adopting = false;

/** A write in flight keeps the last answer, so "Draft saved" doesn't blink at each pause. */
const shownStatus = (shown: DraftStatus | null, next: DraftStatus): DraftStatus =>
  next === "saving" && shown !== null ? shown : next;

const syncOf = (hostKey: string): DraftSync => {
  const existing = syncs.get(hostKey);

  if (existing !== undefined) return existing;

  const sync = makeDraftSync({
    save: async (sessionId, text) => {
      const result = await polaris().request("continuity.saveDraft", {
        hostKey,
        sessionId,
        text,
      });

      return result.ok ? result.value : null;
    },
    adopt: (sessionId, text) => {
      adopting = true;
      // The Host's draft is the saved one.
      patchSessionUi(uiKey(hostKey, sessionId), () => ({ draft: text, draftStatus: "saved" }));
      adopting = false;
    },
    status: (sessionId, status) =>
      patchSessionUi(uiKey(hostKey, sessionId), (ui) => ({
        draftStatus: shownStatus(ui.draftStatus, status),
      })),
  });

  syncs.set(hostKey, sync);

  return sync;
};

/** The Turn each session's Host acknowledged as read, and the one being reported. */
const acknowledged = new Map<string, TurnId>();

const reporting = new Map<string, TurnId>();

/** The newest ended Turn of each open session, reported again when its Host's feed opens. */
const onScreen = new Map<string, { hostKey: string; sessionId: SessionId; turnId: TurnId }>();

const markRead = (hostKey: string, sessionId: SessionId, turnId: TurnId) => {
  const key = uiKey(hostKey, sessionId);

  if (acknowledged.get(key) === turnId || reporting.get(key) === turnId) return;
  reporting.set(key, turnId);
  void polaris()
    .request("continuity.markRead", { hostKey, sessionId, turnId })
    .then((result) => {
      if (result.ok) acknowledged.set(key, turnId);
    })
    .finally(() => {
      if (reporting.get(key) === turnId) reporting.delete(key);
    });
};

const reportOnScreen = (hostKey: string) => {
  if (document.visibilityState !== "visible") return;

  for (const read of onScreen.values())
    if (read.hostKey === hostKey) markRead(read.hostKey, read.sessionId, read.turnId);
};

const open = (hostKey: string, held: Held) => {
  const sync = syncOf(hostKey);
  held.close = polaris().subscribe(
    "continuity",
    { hostKey },
    {
      items: (items) => {
        for (const item of items)
          ContinuityItem.match(item, {
            // A Snapshot means the Host is reachable: what failed before goes again first.
            Snapshot: ({ drafts }) => {
              void sync.retry();
              drafts.forEach(sync.receive);
              reportOnScreen(hostKey);
            },
            Draft: ({ draft }) => sync.receive(draft),
            Read: () => undefined,
          });
      },
      end: () =>
        setTimeout(() => {
          if (hosts.get(hostKey) === held) open(hostKey, held);
        }, REOPEN_MS),
    }
  );
};

const hold = (hostKey: string) => {
  const existing = hosts.get(hostKey);

  if (existing !== undefined) existing.refs++;
  else {
    const held: Held = { refs: 1, close: () => undefined };
    hosts.set(hostKey, held);
    open(hostKey, held);
  }

  return () => {
    const held = hosts.get(hostKey);

    if (held === undefined || --held.refs > 0) return;
    hosts.delete(hostKey);
    held.close();
  };
};

// Every change to a draft, typed or cleared on send, goes to its Host while the Host is held.
onDraftChange((key, draft) => {
  if (adopting) return;
  const [hostKey, sessionId] = key.split("\u0000");
  const sync = hostKey === undefined || !hosts.has(hostKey) ? undefined : syncs.get(hostKey);

  if (sync !== undefined && sessionId !== undefined) sync.edit(SessionId.make(sessionId), draft);
});

/**
 * Keeps the Host's draft and read position in step with the open session:
 * `lastEnded` is the newest ended Turn on screen, read once the window is visible.
 */
export const useSessionContinuity = (options: {
  readonly hostKey: string;
  readonly sessionId: SessionId;
  readonly enabled: boolean;
  readonly lastEnded: TurnId | null;
}) => {
  const { hostKey, sessionId, enabled, lastEnded } = options;

  useEffect(() => {
    if (!enabled) return;
    const release = hold(hostKey);

    // Leaving the session writes what's still pending at once.
    return () => {
      void syncs.get(hostKey)?.flush(sessionId);
      release();
    };
  }, [hostKey, sessionId, enabled]);

  useEffect(() => {
    if (!enabled || lastEnded === null) return;
    const key = uiKey(hostKey, sessionId);
    onScreen.set(key, { hostKey, sessionId, turnId: lastEnded });

    const report = () => {
      if (document.visibilityState === "visible") markRead(hostKey, sessionId, lastEnded);
    };

    report();
    document.addEventListener("visibilitychange", report);

    return () => {
      onScreen.delete(key);
      document.removeEventListener("visibilitychange", report);
    };
  }, [hostKey, sessionId, enabled, lastEnded]);
};
