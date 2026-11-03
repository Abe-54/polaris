/**
 * Review's commands to the Host, one submission slot per reviewed subject and action. A slot holds
 * one command at a time, and a retry after a lost reply reuses its command and item ids.
 */
import { type Command, CommandId } from "@polaris/protocol";
import { Effect, Predicate } from "effect";
import { uniqueId } from "./actions.ts";
import { DEVICE_COPY } from "../app/platformCopy.ts";

/** Sends a command under its id; a `ReviewRefused` failure is definite, any other may have landed. */
export type ReviewDispatch = (
  command: Command,
  commandId: CommandId
) => Effect.Effect<void, { readonly message: string }>;

export type SubmissionState =
  | { readonly kind: "sending" }
  | { readonly kind: "sent" }
  | { readonly kind: "failed"; readonly message: string; readonly refused: boolean };

interface Held {
  /** What was submitted, so a changed submission gets fresh ids. */
  readonly payload: string;
  readonly commandId: CommandId;
  /** The feedback comment's or verdict's id inside the command. */
  readonly itemId: string;
}

export interface ReviewSubmissions {
  /** Answers why it failed, or null; a second submit while one is in flight joins it. */
  readonly submit: (
    slot: string,
    payload: string,
    build: (itemId: string) => Command,
    dispatch: ReviewDispatch
  ) => Promise<string | null>;
  readonly state: (slot: string) => SubmissionState | null;
  readonly subscribe: (listener: () => void) => () => void;
  readonly version: () => number;
}

export const reviewSlot = {
  accept: (sessionId: string, turnId: string) => `accept:${sessionId}:${turnId}`,
  sendBack: (sessionId: string, turnId: string) => `send-back:${sessionId}:${turnId}`,
  fix: (sessionId: string, findingId: string) => `fix:${sessionId}:${findingId}`,
  verdict: (summaryId: string, findingId: string) => `verdict:${summaryId}:${findingId}`,
};

export const reviewSubmissions = (): ReviewSubmissions => {
  const inFlight = new Map<string, Promise<string | null>>();
  const held = new Map<string, Held>();
  const states = new Map<string, SubmissionState>();
  const listeners = new Set<() => void>();
  let version = 0;

  const set = (slot: string, state: SubmissionState) => {
    states.set(slot, state);
    version += 1;
    listeners.forEach((listener) => listener());
  };

  const settle = (slot: string) =>
    Effect.match({
      onSuccess: () => {
        set(slot, { kind: "sent" });

        return null;
      },
      onFailure: (error: { readonly message: string }) => {
        const refused = Predicate.isTagged(error, "ReviewRefused");

        // Refused means nothing landed, so the next try is a new command.
        if (refused) held.delete(slot);
        set(slot, { kind: "failed", message: error.message, refused });

        return error.message;
      },
    });

  const submit: ReviewSubmissions["submit"] = (slot, payload, build, dispatch) => {
    const running = inFlight.get(slot);

    if (running !== undefined) return running;
    const kept = held.get(slot);

    if (kept?.payload === payload && states.get(slot)?.kind === "sent")
      return Promise.resolve(null);

    const ids =
      kept?.payload === payload
        ? kept
        : { payload, commandId: CommandId.make(uniqueId()), itemId: uniqueId() };

    held.set(slot, ids);
    set(slot, { kind: "sending" });

    const sent = Effect.runPromise(dispatch(build(ids.itemId), ids.commandId).pipe(settle(slot)))
      .catch(() => {
        const message = `Something went wrong on this ${DEVICE_COPY.phone}`;

        set(slot, { kind: "failed", message, refused: false });

        return message;
      })
      .finally(() => inFlight.delete(slot));

    inFlight.set(slot, sent);

    return sent;
  };

  return {
    submit,
    state: (slot) => states.get(slot) ?? null,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    version: () => version,
  };
};

/** Slots per Host, above the screens: Review and the Duo context pane share them across remounts. */
export const hostSubmissions = () => {
  const byHost = new Map<string, ReviewSubmissions>();

  return (hostId: string) => {
    const kept = byHost.get(hostId) ?? reviewSubmissions();

    byHost.set(hostId, kept);

    return kept;
  };
};

/** The running app's slots. */
export const submissionsFor = hostSubmissions();
