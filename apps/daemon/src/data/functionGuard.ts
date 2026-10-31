/** Catalog checks run on the same read-only reservation as the user's statement. */
import type { TransactionSQL } from "bun";
import { DataError } from "@polaris/protocol";
import { functionCalls, guardFunctionCalls, type LexicalMode } from "./guard.ts";

export async function guardFunctions(tx: TransactionSQL, sql: string, mode: LexicalMode) {
  guardFunctionCalls(sql, mode);
  const calls = functionCalls(sql, mode);

  if (calls.length === 0) return;
  const names = [...new Set(calls.map((call) => call.name))];

  const unsafe =
    mode.engine === "postgres"
      ? await tx<Array<{ name: string; schema: string }>>`
        SELECT p.proname AS name,n.nspname AS schema FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
        WHERE p.proname = ANY(${names}::text[]) AND (
          (p.prosecdef AND r.rolsuper) OR EXISTS (
            SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
            WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e'
            AND e.extname IN ('dblink','postgres_fdw','adminpack')))`
      : await tx<Array<{ name: string; schema?: string }>>`SELECT name FROM mysql.func`;

  if (
    unsafe.some((fn) =>
      calls.some(
        (call) =>
          call.name.toLowerCase() === fn.name.toLowerCase() &&
          (call.schema === undefined || fn.schema === undefined || call.schema === fn.schema)
      )
    )
  )
    throw new DataError({
      code: "E-DATA-READ-ONLY",
      message: "This statement calls a function that can act outside its transaction.",
      fix: "Remove the privileged function and connect with a SELECT-only database user.",
    });
}
