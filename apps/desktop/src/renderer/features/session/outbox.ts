/**
 * The session's outbox (`model/outbox.ts`) at work: sends steers and queued
 * follow-ups, settles them as the feed shows them landing, and retries or
 * returns them to the draft. Run once per open session (the Intent column).
 */
import type { SessionId } from "@polaris/protocol";
import { useEffect } from "react";
import { Commands } from "../../commands.ts";
import type { SessionModel } from "../../store/sessionModel.ts";
import { dispatch, refusalText } from "./dispatch.ts";
import { queuedCommand } from "./model/intent.ts";
import {
  nextQueued,
  queuedOutgoing,
  settleOutbox,
  steerOutgoing,
  type Outgoing,
} from "./model/outbox.ts";
import {
  dropOutgoing,
  patchOutgoing,
  patchSessionUi,
  type StagedAttachment,
  useSessionUi,
} from "./state.ts";

export type Outbound = Outgoing<StagedAttachment>;

export interface OutboxInput {
  readonly hostKey: string;
  readonly uiKey: string;
  readonly sessionId: SessionId;
  readonly model: SessionModel;
  /** The session takes a new Turn now (the composer would send). */
  readonly ready: boolean;
  /** A Turn is in flight and can be steered. */
  readonly canSteer: boolean;
}

export interface OutboxActions {
  /** Attachments go only where the Daemon and Harness take them in a steer (`steersAttachments`). */
  readonly steer: (text: string, attachments?: ReadonlyArray<StagedAttachment>) => void;
  /** `shell`: a shell command (`!…`), run as the next Turn. */
  readonly queue: (
    text: string,
    attachments: ReadonlyArray<StagedAttachment>,
    shell?: boolean
  ) => void;
  readonly retry: (id: string) => void;
  /** Back into the draft (cancelling a queued follow-up, or editing a failed one). */
  readonly edit: (id: string) => void;
}

/** A steer's fields; `attachments` only when it carries some, so older Daemons decode it. */
const steerFields = (sessionId: SessionId, entry: Outbound) =>
  entry.attachments.length === 0
    ? { sessionId, text: entry.text }
    : { sessionId, text: entry.text, attachments: entry.attachments.map((a) => a.id) };

const append = (draft: string, text: string) => (draft.trim() === "" ? text : `${draft}\n${text}`);

/** Dispatch an entry's command; it goes `sent`, or `failed` with the Daemon's reason. */
const deliver = (hostKey: string, uiKey: string, entry: Outbound, sessionId: SessionId) => {
  const command =
    entry.kind === "steer"
      ? Commands.Steer(steerFields(sessionId, entry))
      : queuedCommand(sessionId, {
          text: entry.text,
          attachments: entry.attachments.map((a) => a.id),
          shell: entry.shell === true,
        });

  if (command === null) return dropOutgoing(uiKey, entry.id);

  void dispatch(hostKey, command).then((sent) =>
    patchOutgoing(uiKey, entry.id, () =>
      sent.ok ? { status: "sent" } : { status: "failed", error: refusalText(sent.error) }
    )
  );
};

/** Drops what landed and fails steers whose Turn ended, as the feed changes. */
const useSettle = (uiKey: string, turns: SessionModel["turns"], outbox: ReadonlyArray<Outbound>) =>
  useEffect(() => {
    const next = settleOutbox(outbox, turns);

    if (next !== outbox) patchSessionUi(uiKey, () => ({ outbox: next }));
  }, [uiKey, turns, outbox]);

/** Sends the first waiting follow-up once the session takes a Turn again. */
const useSendQueued = (input: OutboxInput, outbox: ReadonlyArray<Outbound>) => {
  const { hostKey, uiKey, sessionId, ready, model } = input;
  const turnCount = model.turns.length;

  useEffect(() => {
    const next = ready ? nextQueued(outbox) : null;

    if (next === null) return;
    const sending: Outbound = { ...next, status: "sending", baseline: turnCount, error: null };
    patchOutgoing(uiKey, next.id, () => sending);
    deliver(hostKey, uiKey, sending, sessionId);
  }, [ready, outbox, hostKey, uiKey, sessionId, turnCount]);
};

export const useOutbox = (input: OutboxInput): OutboxActions => {
  const { hostKey, uiKey, sessionId, model, canSteer } = input;
  const { outbox } = useSessionUi(uiKey);
  const live = model.turns.at(-1);

  useSettle(uiKey, model.turns, outbox);
  useSendQueued(input, outbox);

  const add = (entry: Outbound) =>
    patchSessionUi(uiKey, (ui) => ({ outbox: [...ui.outbox, entry] }));

  const steer = (text: string, attachments: ReadonlyArray<StagedAttachment> = []) => {
    if (live === undefined) return;
    const entry = steerOutgoing(model.turns, live.turn.id, text, attachments);

    add(entry);
    deliver(hostKey, uiKey, entry, sessionId);
  };

  const retry = (id: string) => {
    const entry = outbox.find((e) => e.id === id);

    if (entry === undefined) return;

    if (entry.kind === "steer" && canSteer && live !== undefined) {
      const again = steerOutgoing(model.turns, live.turn.id, entry.text, entry.attachments);

      patchOutgoing(uiKey, entry.id, () => ({ ...again, id: entry.id }));
      deliver(hostKey, uiKey, { ...again, id: entry.id }, sessionId);

      return;
    }

    // A steer whose Turn is over goes as the next Turn instead.
    patchOutgoing(uiKey, entry.id, () => ({
      kind: "queued",
      turnId: null,
      status: "waiting",
      error: null,
    }));
  };

  const edit = (id: string) =>
    patchSessionUi(uiKey, (ui) => {
      const entry = ui.outbox.find((e) => e.id === id);

      if (entry === undefined) return {};

      return {
        outbox: ui.outbox.filter((e) => e.id !== id),
        draft: append(ui.draft, entry.text),
        attachments: [...ui.attachments, ...entry.attachments],
      };
    });

  return {
    steer,
    queue: (text, attachments, shell) => add(queuedOutgoing(text, attachments, shell)),
    retry,
    edit,
  };
};
