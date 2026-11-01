/**
 * Where the Data tab's actions go: "Open in Data" to the table a write or schema change touched
 * (in its schema), "Schema diff" to Review at the Turn shown, "Query log" filtered to it.
 */
import type {
  DataSource,
  DataValue,
  QueryLogEntry,
  SchemaSourceDiff,
  TurnId,
} from "@polaris/protocol";
import { openSessionReview } from "../../../routes/review.ts";
import type { ShellActions } from "../../../routes/navigation.ts";
import { setTab } from "../../review/overview/index.ts";
import { openSchemaDiff } from "../../review/schema/store.ts";
import { subjectKey } from "../../review/surface.ts";
import { sourceForTarget } from "../approval/decide.ts";
import type { DataWrite } from "../write/model.ts";
import { showLogTurn } from "../model/sidebar.ts";
import { type DataSessionKey, openSqlTab, openTable } from "../model/store.ts";
import { defaultSchema, schemaTarget, type TurnWrite, writeTable } from "./model.ts";

/** The Turn the tab shows: its number and its Turns' ids, the first being the group's. */
export interface ShownTurn {
  readonly number: number;
  readonly ids: ReadonlyArray<string>;
}

export const dataOpeners = (
  at: DataSessionKey,
  sources: ReadonlyArray<DataSource>,
  actions: Pick<ShellActions, "selectSession" | "setMode">
) => {
  const toData = () => {
    actions.selectSession(at);
    actions.setMode("data");
  };

  /** The table the write touched, in its schema; its SQL in a SQL tab when no table is named. */
  const openWrite = (
    source: DataSource | undefined,
    ran: Pick<QueryLogEntry, "sql" | "affected"> & { readonly params?: ReadonlyArray<DataValue> }
  ) => {
    const table = source === undefined ? null : writeTable(ran, defaultSchema(source));

    if (source !== undefined && table !== null) openTable(source.name, table, at);
    else openSqlTab(ran.sql, source?.name ?? "", at, ran.params ?? []);
    toData();
  };

  return {
    write: ({ entry, approval }: TurnWrite) =>
      openWrite(
        sources.find((s) => s.id === entry.source.id) ??
          (approval === null ? undefined : sourceForTarget(sources, approval.write.target)),
        entry
      ),
    /** A write's card in the conversation: its table, as the Daemon counted it once it ran. */
    approval: (write: DataWrite, entry: QueryLogEntry | undefined) => {
      const ran: Parameters<typeof openWrite>[1] = { sql: write.sql, params: write.params ?? [] };

      openWrite(
        sourceForTarget(sources, write.target),
        entry?.affected === undefined ? ran : { ...ran, affected: entry.affected }
      );
    },
    schema: (diff: SchemaSourceDiff) => {
      const target = schemaTarget(diff);

      if (target.kind === "table") openTable(diff.source.name, target.ref, at);
      toData();
    },
    schemaDiff: (diff: SchemaSourceDiff, turn: ShownTurn) => {
      const key = subjectKey({ kind: "session", hostKey: at.hostKey, sessionId: at.sessionId });
      // SAFETY: the shown Turn's ids come from the session's Turn views.
      const turnId = turn.ids[0] as TurnId | undefined;

      actions.selectSession(at);
      openSessionReview(actions, at.hostKey, at.sessionId, turnId);
      setTab(key, "changes");
      openSchemaDiff(key, diff.source.id);
    },
    log: (turn: ShownTurn) => {
      showLogTurn(at, { turnIds: turn.ids, label: `Turn ${turn.number}` });
      toData();
    },
  };
};
