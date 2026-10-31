/** Grid cells are grouped by primary key so each row is updated and counted once. */
import type { CommitDataEdits, DataSource, DataValue } from "@polaris/protocol";
import { identifier, writeError } from "./writeSql.ts";

export type EditInput = typeof CommitDataEdits.payloadSchema.Type;

export function editStatements(input: EditInput, engine: DataSource["engine"]) {
  const groups = new Map<
    string,
    { key: ReadonlyArray<DataValue>; changes: Map<string, DataValue> }
  >();

  for (const edit of input.edits) {
    if (edit.key.length !== input.primaryKey.length || input.primaryKey.includes(edit.column))
      throw writeError("Edits require a complete primary key and cannot change key columns.");
    const identity = JSON.stringify(edit.key);
    let group = groups.get(identity);

    if (!group) {
      group = { key: edit.key, changes: new Map() };
      groups.set(identity, group);
    }

    if (group.changes.has(edit.column))
      throw writeError(
        "The same cell appears more than once in these edits.",
        "Reload the table and stage each cell once."
      );
    group.changes.set(edit.column, edit.value);
  }

  const table = `${identifier(input.table.schema, engine)}.${identifier(input.table.name, engine)}`;
  const bind = (n: number) => (engine === "postgres" ? `$${n}` : "?");

  return [...groups.values()].map((group) => {
    const changes = [...group.changes];

    const set = changes
      .map(([column], i) => `${identifier(column, engine)}=${bind(i + 1)}`)
      .join(", ");

    const where = input.primaryKey
      .map((column, i) => `${identifier(column, engine)}=${bind(changes.length + i + 1)}`)
      .join(" AND ");

    return {
      sql: `UPDATE ${table} SET ${set} WHERE ${where}`,
      params: [...changes.map(([, value]) => value), ...group.key],
    };
  });
}
