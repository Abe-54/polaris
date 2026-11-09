/** ⌘W in Data (`tab.close`): closes the open tab; with none open, the window, as elsewhere. */
import { useEffect } from "react";
import { useCommands } from "../../../shell/hooks.ts";
import { closeDataTab, type DataSessionKey } from "../model/store.ts";

export const useCloseTab = (at: DataSessionKey, active: string | null) => {
  const commands = useCommands();
  const { hostKey, sessionId } = at;

  useEffect(() => {
    return commands.register({
      "tab.close": {
        run: () => {
          if (active === null) window.close();
          else closeDataTab(active, { hostKey, sessionId });
        },
      },
    });
  }, [commands, active, hostKey, sessionId]);
};
