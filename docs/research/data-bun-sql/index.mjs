import { connect, emit, engine } from "./report.mjs";
import { setup } from "./setup.mjs";
import { transactions, timeouts } from "./transactions.mjs";
import { types } from "./types.mjs";
import { introspection } from "./introspection.mjs";
import { pooling } from "./pooling.mjs";
import { mysqlGuard } from "./mysql-guard.mjs";
import { protocol } from "./protocol.mjs";
import { locking } from "./locking.mjs";

emit("runtime", { bun: Bun.version, revision: Bun.revision, platform: process.platform, arch: process.arch });
const sql = connect();
try {
  if (!process.argv.includes("--existing")) await setup(sql);
  await transactions(sql);
  await protocol();
  await timeouts(sql);
  await mysqlGuard(sql);
  await locking();
  await types(sql);
  await introspection(sql);
  await pooling();
} finally {
  await sql.close({ timeout: 0 });
}
for (const mode of ["buffered", "values", "raw", "limit", ...(engine === "postgres" ? ["cursor-all", "cursor-cap"] : [])]) {
  const child = Bun.spawn([process.execPath, new URL("memory.mjs", import.meta.url).pathname, engine, mode], { stdout: "inherit", stderr: "inherit", env: process.env });
  if (await child.exited !== 0) throw new Error(`Memory probe failed: ${mode}`);
}
