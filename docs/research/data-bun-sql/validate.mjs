import assert from "node:assert/strict";
import { join } from "node:path";

const directory = process.argv[2];
const read = async name => (await Bun.file(join(directory, name)).text()).trim().split("\n").map(line => JSON.parse(line));
for (const engine of ["postgres", "mysql"]) {
  const records = await read(`${engine}.ndjson`);
  const one = label => {
    const record = records.find(row => row.label === label);
    assert.ok(record, `Missing ${engine}/${label}`);
    return record;
  };
  const errno = engine === "postgres" ? "25006" : 1792;
  assert.equal(one("begin-read-only-option").error.errno, errno);
  const readonly = records.filter(row => row.label === "read-only");
  assert.equal(readonly.find(row => row.statements.at(-1).startsWith("INSERT")).error.errno, errno);
  const guarded = records.filter(row => row.label === "protocol-tagged-unsafe-fragment");
  assert.equal(guarded.length, 2);
  assert.ok(guarded.every(row => row.error.errno === (engine === "postgres" ? "42601" : 1064)));
  const postconditions = records.filter(row => row.label === "protocol-tagged-unsafe-fragment-postcondition");
  assert.ok(postconditions.every(row => row.result.rows[0].v === 0));
  assert.equal(one("types-default-first").values.n.value, "12345678901234567890.12345678901234567890");
  assert.equal(one("types-default-first").values.big.value, "9223372036854775807");
  assert.equal(one("memory-limit").count, 201);
  assert.equal(one("memory-buffered").count, 1000000);
  const lsp = await read(`sqllens-${engine}.ndjson`);
  assert.equal(lsp.filter(row => row.found).length, 2);
  if (engine === "mysql") {
    assert.equal(one("ddl-persisted").result.rows.length, 2);
    assert.equal(one("reader-ddl").error.errno, 1142);
    assert.equal(one("select-timeout").error.errno, 3024);
    assert.equal(one("mysql-kill-query").error.errno, 1317);
    assert.equal(one("kill-update-postcondition").result.rows[0].v, 0);
    const decisions = records.filter(row => row.label === "mysql-guard-decision");
    const escapes = decisions.filter(row => /OUTFILE|DUMPFILE|LOAD_FILE|\/\*!|\/\*\+|^CREATE|^DROP|^CALL|^SET|^DO |^HANDLER|^LOCK TABLES|^XA |^PREPARE|^EXECUTE/i.test(row.statement) || row.statement === "SELECT 1; DROP TABLE guard_target");
    assert.ok(escapes.length >= 20);
    assert.ok(escapes.every(row => row.combinedAllowed === false));
    assert.equal(one("mysql-guard-sql-mode").combinedAllowed, false);
    assert.equal(records.filter(row => row.label === "mysql-share-lock-released" && row.affectedRows === 1).length, 2);
    assert.equal(records.filter(row => row.label === "mysql-share-lock-held" && row.error.errno === 1205).length, 2);
  }
}
console.log(JSON.stringify({ label: "validation", result: "passed", engines: ["postgres", "mysql"] }));
