/**
 * The SQL tab (DESIGN.md, Data → SQL tab; Paper D2): the run bar, the editor completing from the
 * chosen Data Source's schema (ENG-649), and the results under it.
 */
import { useEffect, useState } from "react";
import { useDataApi, useDataSources } from "../data/hooks.tsx";
import { formatSql } from "../sql/language.ts";
import {
  runSqlTab,
  setSqlSource,
  setSqlText,
  type SqlTab,
  takeQueuedRun,
  useSqlTab,
} from "../sql/state.ts";
import { useCatalog } from "../sql/useCatalog.ts";
import type { DataTabProps } from "./slots.ts";
import { Results } from "./sql/Results.tsx";
import { RunBar } from "./sql/RunBar.tsx";
import { SqlEditor } from "./sql/SqlEditor.tsx";

export const sqlTabTitle = (tab: SqlTab) => tab.title;

export const SqlTabBody = ({ at, tab }: DataTabProps<SqlTab>) => {
  const api = useDataApi();
  const state = useSqlTab(at, tab);
  const sources = useDataSources(at);
  const list = sources.status === "ready" ? sources.value : [];
  const source = list.find((s) => s.name === state.source);
  const catalog = useCatalog(at, state.source, state.text);
  const [formatProblem, setFormatProblem] = useState<string | null>(null);
  const run = () => void runSqlTab(api, at, tab);
  const { run: last } = state;

  // A re-run from the Query Log opens this tab with its query already running.
  useEffect(() => {
    if (takeQueuedRun(at, tab.id)) void runSqlTab(api, at, tab);
  }, [api, at, tab]);

  const format = async () => {
    const formatted = await formatSql(state.text, source?.engine ?? "postgres");

    if (formatted.ok) setSqlText(at, tab, formatted.text);
    setFormatProblem(formatted.ok ? null : formatted.message);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="data-sql-tab">
      <RunBar
        sources={list}
        source={source}
        catalog={catalog}
        running={last.status === "running"}
        formatProblem={formatProblem}
        onSource={(name) => setSqlSource(at, tab, name)}
        onFormat={() => void format()}
        onRun={run}
      />
      <div className="flex h-[40%] min-h-[120px] shrink-0 flex-col">
        <SqlEditor
          text={state.text}
          engine={source?.engine ?? "postgres"}
          catalog={catalog.status === "ready" ? catalog.catalog : null}
          error={
            last.status === "failed" && last.span !== null && last.sql === state.text
              ? { span: last.span, message: last.error.message }
              : null
          }
          onChange={(text) => {
            setSqlText(at, tab, text);
            setFormatProblem(null);
          }}
          onRun={run}
          label={`${tab.title} on ${state.source}`}
        />
      </div>
      <div className="border-hairline flex min-h-0 flex-1 flex-col border-t">
        <Results at={at} source={state.source} run={last} />
      </div>
    </div>
  );
};
