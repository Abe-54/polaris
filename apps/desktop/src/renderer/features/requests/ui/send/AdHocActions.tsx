/**
 * An agent's send that isn't a saved Request: "not saved", "Save as request" (a new draft in
 * http/requests.http, as recorded) and "Send again". A send whose secret was masked can't be resent.
 */
import { RequestTarget, type Send } from "@polaris/protocol";
import { PixelAlertIcon, showToast } from "@polaris/ui";
import { useRequestsApi, useRequestsSnapshot } from "../../data/hooks.tsx";
import { draftFromAdHoc, NEW_REQUEST_FILE } from "../../model/draft.ts";
import type { RequestsSessionKey } from "../../model/session.ts";
import { openNewDraft, setLatestSend, setSending } from "../../model/store.ts";
import { lostSecret, recordedRequest } from "./model.ts";

const LINK =
  "text-caption text-text-subtle hover:text-text-default focus-visible:ring-starlight shrink-0 cursor-default rounded-control px-1 outline-none focus-visible:ring-2 disabled:opacity-(--opacity-dimmed)";

/** The names the new-request file has, so a saved send never takes one. */
const useTakenNames = (at: RequestsSessionKey) => {
  const snapshot = useRequestsSnapshot(at);

  return new Set(
    snapshot.status === "ready"
      ? snapshot.value.files
          .filter((f) => f.path === NEW_REQUEST_FILE)
          .flatMap((f) => f.requests.map((r) => r.name))
      : []
  );
};

export const useSendAgain = (at: RequestsSessionKey, send: Send) => {
  const api = useRequestsApi();

  return async () => {
    setSending(at, true);

    const result = await api.send(at, {
      target: RequestTarget.cases.Inline.make({ request: recordedRequest(send) }),
      environment: send.environment ?? null,
    });

    if (result.ok) return setLatestSend(at, result.value);
    setSending(at, false);
    showToast({
      source: "starlight",
      icon: <PixelAlertIcon size={16} />,
      title: "Couldn't send again",
      message:
        result.error.fix === undefined
          ? result.error.message
          : `${result.error.message}. ${result.error.fix}`,
    });
  };
};

export const AdHocActions = ({
  at,
  send,
  sending,
}: {
  readonly at: RequestsSessionKey;
  readonly send: Send;
  readonly sending: boolean;
}) => {
  const taken = useTakenNames(at);
  const sendAgain = useSendAgain(at, send);
  const masked = lostSecret(send);

  return (
    <div className="px-panel -mt-1 flex items-center gap-2 pb-2.5">
      <button
        type="button"
        className={LINK}
        onClick={() => openNewDraft(at, draftFromAdHoc(recordedRequest(send), taken))}
        data-testid="send-save-as-request"
      >
        Save as request
      </button>
      <button
        type="button"
        className={LINK}
        disabled={sending || masked}
        title={
          masked
            ? "A secret in this send was masked. Save it as a request and use its variable"
            : undefined
        }
        onClick={() => void sendAgain()}
        data-testid="send-again"
      >
        Send again
      </button>
    </div>
  );
};
