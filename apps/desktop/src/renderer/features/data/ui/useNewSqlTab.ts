/** ⌘T in Data (`data.newSqlTab`): a new SQL tab on the open tab's Data Source, else the first. */
import { useEffect } from "react";
import { useCommands } from "../../../shell/hooks.ts";
import { useDataSources } from "../data/hooks.tsx";
import { type DataSessionKey, openSqlTab } from "../model/store.ts";
import type { DataTab } from "../model/tabs.ts";
import { useSqlSource } from "../sql/state.ts";

export const useNewSqlTab = (at: DataSessionKey, active: DataTab | null) => {
  const commands = useCommands();
  const sources = useDataSources(at);
  const sqlSource = useSqlSource(at, active);
  const first = sources.status === "ready" ? sources.value[0]?.name : undefined;
  const source = sqlSource ?? active?.sourceId ?? first;
  const { hostKey, sessionId } = at;

  useEffect(
    () =>
      source === undefined
        ? undefined
        : commands.register({
            "data.newSqlTab": { run: () => openSqlTab("", source, { hostKey, sessionId }) },
          }),
    [commands, source, hostKey, sessionId]
  );
};
