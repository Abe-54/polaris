/**
 * Sending commands from the session view. A refusal comes back with the
 * Daemon's reason ("interrupt the Turn in flight before archiving"), which is
 * what the user reads; it's shown as a Polaris toast unless the caller shows it.
 */
import type { Command, SessionId } from "@polaris/protocol";
import { PixelFailedIcon, showToast } from "@polaris/ui";
import { createElement } from "react";
import type { IpcError } from "../../../shared/api.ts";
import { Commands, newCommandId } from "../../commands.ts";
import { hostTextOf } from "../../store/hostKinds.ts";
import { polaris } from "../bridge.ts";
import { actionTraces, selfTraces } from "../selfTraces/index.ts";
import { BACKGROUND_FAILED_TITLE } from "./model/backgroundFailures.ts";

export type Sent = { readonly ok: true } | { readonly ok: false; readonly error: IpcError };

/** While Self-Traces are on, a command (a Turn from the composer) has a Span, in its action's Trace. */
export const dispatch = async (hostKey: string, command: Command): Promise<Sent> => {
  const action = actionTraces.adopt();

  const span = selfTraces()?.start(
    `dispatch ${command._tag}`,
    { "polaris.command": command._tag },
    action?.trace
  );

  const result = await polaris().request(
    "dispatch",
    { hostKey, commandId: newCommandId(), command },
    span === null || span === undefined ? undefined : { trace: span.trace }
  );

  span?.end(result.ok ? undefined : result.error.message);
  action?.settle();

  return result.ok ? { ok: true } : { ok: false, error: result.error };
};

/** The user gate's refusal (ADR 0100): who holds user access, and how to move it here. */
const userAccessText = (error: IpcError, hostKey: string | undefined): string => {
  const host = hostTextOf(hostKey);
  const what = error.message.startsWith("dispatch:RespondToApproval") ? "approve" : "do this";

  return `This desktop app can't ${what} on ${host} yet: another one holds user access. To move it here, delete ~/.polaris/user-access.json on ${host} and reconnect.`;
};

/** The Daemon's reason, first letter up: "Interrupt the Turn in flight before archiving". */
export const refusalText = (error: IpcError, hostKey?: string): string => {
  if (error.code === "UserAccessRequired") return userAccessText(error, hostKey);
  const text = error.message.replace(/^CommandRejected:\s*/, "").trim();

  return text === "" ? error.code : text.charAt(0).toUpperCase() + text.slice(1);
};

/** A failure toast: "Couldn't archive" over what went wrong. */
export const showFailure = (title: string, message: string) =>
  showToast({
    source: "starlight",
    icon: createElement(PixelFailedIcon, { size: 16 }),
    title,
    message,
  });

export const showRefusal = (title: string, error: IpcError, hostKey?: string) =>
  showFailure(title, refusalText(error, hostKey));

/** Dispatch, and toast the refusal under `title` ("Couldn't archive"). */
export const send = async (hostKey: string, command: Command, title: string) => {
  const sent = await dispatch(hostKey, command);

  if (!sent.ok) showRefusal(title, sent.error, hostKey);

  return sent.ok;
};

/** Move a running command (every one when `itemId` is null) into the background, as Ctrl-B does. */
export const runInBackground = (hostKey: string, sessionId: SessionId, itemId: string | null) =>
  send(hostKey, Commands.BackgroundCommand({ sessionId, itemId }), BACKGROUND_FAILED_TITLE);
