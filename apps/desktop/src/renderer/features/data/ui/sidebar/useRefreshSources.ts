/** Re-lists the checkout's sources whenever the window regains focus; showing Data subscribes anew. */
import { useEffect } from "react";
import { refreshSources } from "../../model/refresh.ts";
import type { DataSessionKey } from "../../model/store.ts";

export const useRefreshSources = ({ hostKey, sessionId }: DataSessionKey) => {
  useEffect(() => {
    const refresh = () => refreshSources({ hostKey, sessionId });

    window.addEventListener("focus", refresh);

    return () => window.removeEventListener("focus", refresh);
  }, [hostKey, sessionId]);
};
