/** The checkout's Send Log, live (`requests.sendLog.watch`): its latest 100 Sends, newest first. */
import type { Send } from "@polaris/protocol";
import { useEffect, useRef, useState } from "react";
import { useApp } from "../../../shell/hooks.ts";
import type { RequestsSessionKey } from "../model/session.ts";
import { type Loaded, useRequestsApi } from "./hooks.tsx";

/** Reopened on each new connection epoch; a failure while the Host is away keeps the last list. */
export const useSendLog = (at: RequestsSessionKey): Loaded<ReadonlyArray<Send>> => {
  const api = useRequestsApi();
  const host = useApp((s) => s.hosts.find((h) => h.key === at.hostKey));
  const epoch = host?.status.epoch ?? 0;
  const away = useRef(host?.status.state !== "connected");
  const [state, setState] = useState<Loaded<ReadonlyArray<Send>>>({ status: "loading" });
  const { hostKey, sessionId } = at;

  away.current = host?.status.state !== "connected";

  useEffect(() => {
    return api.watchSendLog(
      { hostKey, sessionId },
      {
        next: (value) => setState({ status: "ready", value }),
        end: (error) => {
          if (error !== null && !away.current) setState({ status: "failed", error });
        },
      }
    );
  }, [api, hostKey, sessionId, epoch]);

  return state;
};
