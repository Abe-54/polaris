/**
 * The session's `browser.tabs` feed, folded into its Browser state while the session is open,
 * so a tab an agent opens reaches Output whichever tab it shows.
 */
import type { SessionId } from "@polaris/protocol";
import { Predicate } from "effect";
import { useEffect, useRef } from "react";
import { polaris } from "../bridge.ts";
import { applyBrowserEvents } from "./state.ts";

export const browserKey = (hostKey: string, sessionId: string) => `${hostKey}\u0000${sessionId}`;

export const useBrowserFeed = (
  hostKey: string,
  sessionId: SessionId,
  onAgentOpened: () => void
) => {
  const agentOpened = useRef(onAgentOpened);

  agentOpened.current = onAgentOpened;

  useEffect(() => {
    const key = browserKey(hostKey, sessionId);

    return polaris().subscribe(
      "browser.tabs",
      { hostKey, sessionId },
      {
        items: (events) => {
          applyBrowserEvents(key, events);

          if (events.some((e) => Predicate.isTagged(e, "Opened") && e.byAgent))
            agentOpened.current();
        },
      }
    );
  }, [hostKey, sessionId]);
};
