/** Re-lists the checkout's sources when Data shows and whenever the window regains focus. */
import { useEffect } from "react";
import { useDataApi } from "../../data/hooks.tsx";
import type { DataSessionKey } from "../../model/store.ts";

export const useRefreshSources = ({ hostKey, sessionId }: DataSessionKey) => {
  const api = useDataApi();

  useEffect(() => {
    const refresh = () => void api.refreshSources({ hostKey, sessionId });

    refresh();
    window.addEventListener("focus", refresh);

    return () => window.removeEventListener("focus", refresh);
  }, [api, hostKey, sessionId]);
};
