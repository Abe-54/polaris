/**
 * ⌘L's shared half (DESIGN.md, Traces): appends a reference to the shown agent session's draft,
 * as Data's ⌘L does, and says so in a toast with "Open session". A full draft is left alone.
 */
import { MAX_DRAFT_LENGTH } from "@polaris/protocol";
import { PixelCheckIcon, showToast } from "@polaris/ui";
import { useCallback } from "react";
import { useApp, useShellActions } from "../../../shell/hooks.ts";
import { updateDraft } from "../../session/state.ts";
import { appendReference } from "../model/reference.ts";
import type { TracesSessionKey } from "../model/session.ts";

/** Adds `text` for a `what` ("trace", "span", "profile") to the draft. */
export const useAddToSession = (at: TracesSessionKey) => {
  const { hostKey, sessionId } = at;
  const title = useApp((s) => s.hostModels[hostKey]?.sessions.get(sessionId)?.session.title);
  const { setMode, selectSession } = useShellActions();

  return useCallback(
    (text: string, what: string) => {
      let fits = false;

      updateDraft(hostKey, sessionId, (draft) => {
        const next = appendReference(draft, text);

        fits = next.length <= MAX_DRAFT_LENGTH;

        return fits ? next : draft;
      });
      const name = title === undefined || title === "" ? "the agent session" : title;

      showToast({
        source: "starlight",
        icon: <PixelCheckIcon size={16} />,
        title: fits ? `Added the ${what} to ${name}` : `The draft in ${name} is full`,
        message: fits
          ? "It's in the composer; nothing is sent yet."
          : `A draft holds ${MAX_DRAFT_LENGTH.toLocaleString("en-US")} characters. Send or shorten it, then add the ${what} again.`,
        action: {
          label: "Open session",
          onAction: () => {
            selectSession({ hostKey, sessionId });
            setMode("orchestrate");
          },
        },
      });
    },
    [hostKey, sessionId, title, setMode, selectSession]
  );
};
