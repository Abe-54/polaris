/** Privilege warnings are observations, never authorization grants. */
import { type DataSource } from "@polaris/protocol";
import { Schema } from "effect";
import type { DataConnection } from "./connection.ts";
import { executeTransaction } from "./execution.ts";
import type { DataPools } from "./pools.ts";

const rows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ privilege: Schema.String })));

export async function inspectPrivileges(
  pools: DataPools,
  source: DataSource,
  connection: DataConnection,
  signal: AbortSignal
) {
  return executeTransaction(
    pools,
    { source, connection, timeoutMs: 2000 },
    signal,
    "read only",
    async (tx) => {
      const raw: unknown =
        source.engine === "postgres"
          ? await tx`
          SELECT 'superuser' AS privilege FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper
          UNION SELECT rolname AS privilege FROM pg_catalog.pg_roles
            WHERE rolname IN ('pg_signal_backend','pg_read_server_files') AND pg_has_role(current_user,oid,'MEMBER')
          UNION SELECT 'EXECUTE on dblink' AS privilege WHERE EXISTS (
            SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_depend d ON d.objid=p.oid
              AND d.classid='pg_catalog.pg_proc'::regclass AND d.deptype='e'
            JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
            WHERE e.extname='dblink' AND has_function_privilege(current_user,p.oid,'EXECUTE'))`
          : await tx`
          SELECT PRIVILEGE_TYPE AS privilege FROM information_schema.USER_PRIVILEGES
          WHERE PRIVILEGE_TYPE IN ('SUPER','FILE')
            AND GRANTEE=CONCAT(QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',1)),'@',QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',-1)))`;

      return rows(raw).map((row) => row.privilege);
    }
  );
}
