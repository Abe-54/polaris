/** The Host's Agent Sessions as the Working strip needs them: title, Harness, Working, current Turn. */
import type { SessionId } from "@polaris/protocol";
import { useCallback } from "react";
import { useApp } from "../../../shell/hooks.ts";
import type { WorkingFacts, WorkingLookup } from "../model/working.ts";

export const useWorkingLookup = (hostKey: string): WorkingLookup => {
  const sessions = useApp((s) => s.hostModels[hostKey]?.sessions);

  return useCallback(
    (id: SessionId): WorkingFacts | null => {
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
