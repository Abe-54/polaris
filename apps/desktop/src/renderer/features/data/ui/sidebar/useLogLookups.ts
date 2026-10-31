/** The Host read model's facts the Query Log's rows need: each session's title, Harness and state. */
import type { SessionId } from "@polaris/protocol";
import { useMemo } from "react";
import { needsYou } from "../../../../routes/topBar.ts";
import { useApp } from "../../../../shell/hooks.ts";
import { sessionKey } from "../../../../store/store.ts";
import { turnNumber } from "../../../session/model/turnGroups.ts";
import type { LogLookups, SessionFacts } from "../../model/queryLog.ts";

export const useLogLookups = (hostKey: string): LogLookups => {
  const model = useApp((s) => s.hostModels[hostKey]);
  const feeds = useApp((s) => s.sessions);

  return useMemo(
    () => ({
      session: (id: SessionId): SessionFacts | null => {
        const entry = model?.sessions.get(id);

        if (entry === undefined) return null;

        return {
          title: entry.session.title,
          harness: entry.session.harness,
          needsYou: needsYou(entry),
          working: entry.session.state === "working",
        };
      },
      turn: (id: SessionId, turn: string) =>
        turnNumber(feeds[sessionKey(hostKey, id)]?.turns ?? [], turn),
    }),
    [model, feeds, hostKey]
  );
};
