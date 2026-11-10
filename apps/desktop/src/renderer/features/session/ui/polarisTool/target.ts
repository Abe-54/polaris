import { SessionId } from "@polaris/protocol";
import { createContext, useContext } from "react";
import { useShellActions } from "../../../../shell/hooks.ts";

/** The session a row belongs to, for what an item alone can't say (a `notify` banner's record). */
export interface SessionTarget {
  readonly hostKey: string;
  readonly sessionId: SessionId;
}

export const SessionTargetContext = createContext<SessionTarget | null>(null);

export const useSessionTarget = (): SessionTarget | null => useContext(SessionTargetContext);

/** Opens a session the row names on the row's own Host; null outside a session. */
export const useOpenSession = (): ((id: string) => void) | null => {
  const target = useSessionTarget();
  const { selectSession } = useShellActions();

  if (target === null) return null;

  return (id) => selectSession({ hostKey: target.hostKey, sessionId: SessionId.make(id) });
};
