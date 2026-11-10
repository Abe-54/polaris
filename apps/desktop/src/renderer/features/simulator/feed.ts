/**
 * The session's `simulator.sessionFeed`, folded into its Simulator state while the session is
 * open, so an agent opening a Simulator reaches Output whichever tab it shows.
 */
import type { SessionId, SimulatorSessionItem } from "@polaris/protocol";
import { Match } from "effect";
import { useEffect, useRef } from "react";
import { polaris } from "../bridge.ts";
import { keepSubscribed } from "./resubscribe.ts";
import { setDriving, setShowing } from "./state.ts";

/** Folds the feed's items; true when one says an agent opened a Simulator. */
export const applySessionItems = (key: string, items: ReadonlyArray<SimulatorSessionItem>) =>
  items.reduce(
    (opened, item) =>
      Match.value(item).pipe(
        Match.tagsExhaustive({
          Showing: ({ id }) => {
            setShowing(key, id);

            return opened;
          },
          AgentOpened: ({ id }) => {
            setShowing(key, id);

            return true;
          },
          AgentDriving: ({ active }) => {
            setDriving(key, active);

            return opened;
          },
        })
      ),
    false
  );

export const useSimulatorFeed = (
  hostKey: string,
  sessionId: SessionId,
  key: string,
  capable: boolean,
  onAgentOpened: () => void
) => {
  const agentOpened = useRef(onAgentOpened);

  agentOpened.current = onAgentOpened;

  useEffect(() => {
    if (!capable) return;

    return keepSubscribed(({ alive, ended }) =>
      polaris().subscribe(
        "simulator.sessionFeed",
        { hostKey, sessionId },
        {
          items: (items) => {
            alive();

            if (applySessionItems(key, items)) agentOpened.current();
          },
          end: () => {
            setDriving(key, false);
            ended();
          },
        }
      )
    );
  }, [hostKey, sessionId, key, capable]);
};
