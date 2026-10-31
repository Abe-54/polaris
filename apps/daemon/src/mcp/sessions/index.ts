/**
 * What the session tools read from the owning Daemon: another session's Turns
 * (`read_worker`, the history tools) and a session's background commands (`wait_for_command`).
 */
import type { CommandId, SessionId } from "@polaris/protocol";
import { Effect } from "effect";
import type { EventStore } from "../../store/EventStore.ts";
import type { ServiceError } from "../../services.ts";
import { type Notifier, NotifyOutcome, notifier, type NotifyInput } from "./notify.ts";
import {
  HistoryOutcome,
  history,
  type ListOptions,
  type ReadOptions,
  type SearchOptions,
} from "./history.ts";
import { readTranscript } from "./read.ts";
import { WaitOutcome, waitForCommand } from "./wait.ts";
import { SecretOutcome, type SecretRequestInput } from "../../secrets/requests.ts";

export { TRANSCRIPT_LIMIT, transcriptText } from "./transcript.ts";

export { WaitOutcome } from "./wait.ts";

export {
  HistoryOutcome,
  SEARCH_TURN_BUDGET,
  type HistoryScope,
  type ListOptions,
  type ReadOptions,
  type SearchOptions,
} from "./history.ts";

export {
  type AutomaticInput,
  type AutomaticOutcome,
  NOTIFY_INTERVAL_MS,
  type Notifier,
  NotifyOutcome,
  notifier,
  type NotifyInput,
} from "./notify.ts";

export interface TranscriptOptions {
  /** How many of the latest Turns. */
  readonly turns: number;
  /** Only Turns from this one-based number on; null for the latest. */
  readonly since: number | null;
}

export interface WaitOptions {
  /** A background task id; null waits for every background command. */
  readonly task: string | null;
  readonly timeoutMs: number;
}

import type { DataSessionTools } from "./data.ts";

export interface SessionTools {
  readonly data?: DataSessionTools;
  /** The session's Turns as text; null when this Daemon doesn't hold the session. */
  readonly transcript: (
    sessionId: SessionId,
    options: TranscriptOptions
  ) => Effect.Effect<string | null, ServiceError>;
  readonly waitForCommand: (
    sessionId: SessionId,
    options: WaitOptions
  ) => Effect.Effect<WaitOutcome>;
  /** Records `SessionNotified` under `id`, so a retried call sends once. */
  readonly notify: (
    sessionId: SessionId,
    input: NotifyInput,
    id: CommandId
  ) => Effect.Effect<NotifyOutcome, ServiceError>;
  /** History, as seen from the calling session: its own, its Workspace's or the Host's. */
  readonly listSessions: (
    caller: SessionId,
    options: ListOptions
  ) => Effect.Effect<HistoryOutcome, ServiceError>;
  readonly searchHistory: (
    caller: SessionId,
    options: SearchOptions
  ) => Effect.Effect<HistoryOutcome, ServiceError>;
  readonly readHistory: (
    caller: SessionId,
    options: ReadOptions
  ) => Effect.Effect<HistoryOutcome, ServiceError>;
  /** Opens a Secret Request on the session's Turn in flight and waits for it (ADR 0089). */
  readonly requestSecret: (
    sessionId: SessionId,
    input: SecretRequestInput
  ) => Effect.Effect<SecretOutcome, ServiceError>;
}

export const unavailableSessions: SessionTools = {
  transcript: () => Effect.succeed(null),
  waitForCommand: () => Effect.succeed(WaitOutcome.Unavailable()),
  notify: () => Effect.succeed(NotifyOutcome.NotFound()),
  listSessions: () => Effect.succeed(HistoryOutcome.NoCaller()),
  searchHistory: () => Effect.succeed(HistoryOutcome.NoCaller()),
  readHistory: () => Effect.succeed(HistoryOutcome.NoCaller()),
  requestSecret: () => Effect.succeed(SecretOutcome.NotFound()),
};

/** The Daemon's session tools, over its EventStore; `notifications` is shared with Polaris's own. */
export const sessionTools = (
  store: EventStore["Service"],
  notifications: Notifier = notifier(store),
  requestSecret: SessionTools["requestSecret"] = unavailableSessions.requestSecret
): SessionTools => ({
  ...history(store),
  requestSecret,
  notify: notifications.notify,
  transcript: (sessionId, options) => readTranscript(store, sessionId, options),
  waitForCommand: (sessionId, options) => waitForCommand(store, sessionId, options),
});
