/** The Host's Agent Sessions as Data's views name them: title, Harness, Working, current Turn. */
import type { SessionId } from "@polaris/protocol";
import { useCallback } from "react";
import { useApp } from "../../../shell/hooks.ts";
import type { SessionFacts, SessionLookup } from "../model/queryLog.ts";

export const useSessionLookup = (hostKey: string): SessionLookup => {
  const sessions = useApp((s) => s.hostModels[hostKey]?.sessions);

  return useCallback(
    (id: SessionId): SessionFacts | null => {
      const session = sessions?.get(id)?.session;

      if (session === undefined) return null;
      const turn = session.currentUserTurn ?? null;

      return {
        title: session.title,
        harness: session.harness,
        working: session.state === "working",
        turn:
          turn === null
            ? null
            : { id: turn.turnId, number: turn.number, startedAt: turn.startedAt },
      };
    },
    [sessions]
  );
};
