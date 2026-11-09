/** "Open in Traces ⌘5", "Open in Data ⌘4" and "Open statement": select there, then switch mode. */
import type { DataSource } from "@polaris/protocol";
import { useShellActions } from "../../../../shell/hooks.ts";
import { openSqlTab, openTable } from "../../../data/model/store.ts";
import { defaultSchema } from "../../../data/output/model.ts";
import { selectSpan, selectTrace } from "../../../traces/index.ts";
import type { SpanTable } from "../../../traces/model/span/dataSource.ts";
import type { RequestsSessionKey } from "../../model/session.ts";

export const useOpenElsewhere = (at: RequestsSessionKey) => {
  const actions = useShellActions();

  const go = (mode: "traces" | "data") => {
    actions.selectSession(at);
    actions.setMode(mode);
  };

  return {
    trace: (traceId: string, spanId: string | null = null) => {
      selectTrace(at, traceId);

      if (spanId !== null) selectSpan(at, spanId);
      go("traces");
    },
    table: (source: DataSource, table: SpanTable) => {
      openTable(
        source.name,
        { schema: table.schema ?? defaultSchema(source), name: table.name },
        at
      );
      go("data");
    },
    statement: (source: DataSource, sql: string) => {
      openSqlTab(sql, source.name, at);
      go("data");
    },
  };
};
