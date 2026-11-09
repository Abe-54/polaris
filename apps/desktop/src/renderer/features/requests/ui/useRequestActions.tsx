/**
 * What the view does with the open Request: save it (⌘S), send it (⌘↵), copy it as curl, and
 * open a pasted curl command as a new one. Failures say what happened and the fix.
 */
import { PixelAlertIcon, showToast } from "@polaris/ui";
import { useEffect, useRef } from "react";
import type { IpcError } from "../../../../shared/api.ts";
import { useCommands } from "../../../shell/hooks.ts";
import { writeClipboard } from "../../clipboard.ts";
import { useRequestsApi } from "../data/hooks.tsx";
import { draftFromAdHoc, draftOf, refString, targetOf, toHttpRequest } from "../model/draft.ts";
import type { RequestsSessionKey } from "../model/session.ts";
import { dropDraft, openNewDraft, setDraft, setLatestSend, setSending } from "../model/store.ts";
import type { OpenRequest } from "./useOpenRequest.ts";

const failed = (title: string, error: IpcError) =>
  showToast({
    source: "starlight",
    icon: <PixelAlertIcon size={16} />,
    title,
    message: error.fix === undefined ? error.message : `${error.message}. ${error.fix}`,
  });

/** Whether pasted text reads as a curl command. */
export const isCurl = (text: string) => /^curl\s/i.test(text.trimStart());

export const useRequestActions = (
  at: RequestsSessionKey,
  open: OpenRequest | null,
  environment: string | null,
  taken: ReadonlySet<string>
) => {
  const api = useRequestsApi();
  const input = open === null ? null : { target: targetOf(open.draft, open.saved), environment };

  const save = async () => {
    if (open === null || !open.dirty) return;
    const request = toHttpRequest(open.draft);
    const result = await api.save(at, request, open.saved?.name ?? null);

    if (!result.ok) return failed(`Couldn't save ${request.name}`, result.error);
    const written = result.value.requests.find((r) => r.name === request.name);
    const key = refString(request);

    // The file's answer stands in until the watch brings it; then the draft is dropped.
    if (written !== undefined) setDraft(at, key, draftOf(written));

    if (key !== open.key) dropDraft(at, open.key, key);
  };

  const send = async () => {
    if (input === null) return;
    setSending(at, true);
    const result = await api.send(at, input);

    if (result.ok) return setLatestSend(at, result.value);
    setSending(at, false);
    failed("Couldn't send", result.error);
  };

  const copyCurl = async () => {
    if (input === null) return false;
    const result = await api.formatCurl(at, input);

    if (!result.ok) {
      failed("Couldn't copy as curl", result.error);

      return false;
    }

    return writeClipboard(result.value);
  };

  const importCurl = async (text: string) => {
    const result = await api.parseCurl(at, text.trim());

    if (!result.ok) return failed("Couldn't read that curl command", result.error);
    openNewDraft(at, draftFromAdHoc(result.value, taken));
  };

  return {
    save,
    send,
    copyCurl,
    importCurl,
    /** What send, the variables and curl read: the file's Request, or the draft as written. */
    target: input?.target ?? null,
    canSave: open?.dirty === true,
    canSend: input !== null,
  };
};

/** ⌘↵ and ⌘S, while Requests shows (keymapRequests.ts). */
export const useRequestCommands = (actions: ReturnType<typeof useRequestActions>) => {
  const commands = useCommands();
  const latest = useRef(actions);

  latest.current = actions;

  useEffect(() => {
    return commands.register({
      "requests.send": {
        run: () => void latest.current.send(),
        enabled: () => latest.current.canSend,
      },
      "requests.save": {
        run: () => void latest.current.save(),
        enabled: () => latest.current.canSave,
      },
    });
  }, [commands]);
};
