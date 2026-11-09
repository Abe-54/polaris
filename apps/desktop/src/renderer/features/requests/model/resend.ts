/**
 * "Resend in Requests" from a Trace a Send started (DESIGN.md, Traces → Trace bar; Paper Q3): the
 * saved Request it sent is opened, else what was sent opens as a new Request, ready to send.
 */
import type { Send } from "@polaris/protocol";
import { type Draft, draftFromAdHoc, refString } from "./draft.ts";
import type { RequestsSessionKey } from "./session.ts";
import { openNewDraft, openRequest, setEnvironment } from "./store.ts";

/** What an ad-hoc Send sent, as a draft; its `traceparent` is dropped so the resend gets its own. */
export const draftFromSend = (send: Send): Draft => {
  const headers = send.requestHeaders.filter((h) => h.name.toLowerCase() !== "traceparent");
  const request = { method: send.method, url: send.url, headers };

  return draftFromAdHoc(
    send.requestBody === undefined ? request : { ...request, body: send.requestBody },
    new Set()
  );
};

/** Opens `send`'s Request in the session's Requests view, in the environment it was sent in. */
export const loadSend = (at: RequestsSessionKey, send: Send) => {
  if (send.environment !== undefined) setEnvironment(at, send.environment);

  if (send.requestRef === null) openNewDraft(at, draftFromSend(send));
  else openRequest(at, refString(send.requestRef));
};
