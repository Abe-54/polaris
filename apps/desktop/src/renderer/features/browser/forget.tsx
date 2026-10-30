/**
 * Closes an archived session's Browser: each archived session the Host lists is named to main
 * once per run (`browser.forget`), which closes its tabs and stops keeping them.
 */
import type { SessionId } from "@polaris/protocol";
import { useEffect, useRef } from "react";
import { useApp } from "../../shell/hooks.ts";
import type { AppState } from "../../store/store.ts";
import { polaris } from "../bridge.ts";

/** Every archived session as `hostKey\u0001sessionId`, sorted: stable while nothing changes. */
const archivedOf = (state: AppState): string =>
  Object.entries(state.hostModels)
    .flatMap(([hostKey, model]) =>
      [...model.sessions.values()].flatMap(({ session }) =>
        session.state === "archived" ? [`${hostKey}\u0001${session.id}`] : []
      )
    )
    .toSorted()
    .join("\u0002");

export const BrowserForget = () => {
  const archived = useApp(archivedOf);
  const sent = useRef(new Set<string>());

  useEffect(() => {
    const fresh = new Map<string, Array<SessionId>>();

    for (const entry of archived === "" ? [] : archived.split("\u0002")) {
      if (sent.current.has(entry)) continue;
      sent.current.add(entry);

      const [hostKey = "", sessionId = ""] = entry.split("\u0001");

      // SAFETY: the id was read from a folded session, so it is a SessionId.
      fresh.set(hostKey, [...(fresh.get(hostKey) ?? []), sessionId as SessionId]);
    }

    for (const [hostKey, sessionIds] of fresh)
      void polaris().request("browser.forget", { hostKey, sessionIds });
  }, [archived]);

  return null;
};
