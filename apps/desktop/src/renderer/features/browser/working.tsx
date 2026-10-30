/**
 * Tells main which sessions are mid-Turn (`browser.working`): an agent drives a tab only during
 * its session's Turn, so the Turn's end clears "… is using this tab" and the Pick lock.
 */
import type { SessionId } from "@polaris/protocol";
import { useEffect } from "react";
import { useApp } from "../../shell/hooks.ts";
import type { AppState } from "../../store/store.ts";
import { polaris } from "../bridge.ts";

/** Every Working session as `hostKey\u0001sessionId`, sorted: stable while nothing changes. */
export const workingOf = (state: Pick<AppState, "hostModels">): string =>
  Object.entries(state.hostModels)
    .flatMap(([hostKey, model]) =>
      [...model.sessions.values()].flatMap(({ session }) =>
        session.state === "working" ? [`${hostKey}\u0001${session.id}`] : []
      )
    )
    .toSorted()
    .join("\u0002");

export const BrowserWorking = () => {
  const working = useApp(workingOf);

  useEffect(() => {
    const sessions = (working === "" ? [] : working.split("\u0002")).map((entry) => {
      const [hostKey = "", sessionId = ""] = entry.split("\u0001");

      // SAFETY: the id was read from a folded session, so it is a SessionId.
      return { hostKey, sessionId: sessionId as SessionId };
    });

    void polaris().request("browser.working", { sessions });
  }, [working]);

  return null;
};
