import assert from "node:assert/strict";
import { combinedGuard, strictGuard } from "./lexical.mjs";

const pg = [
  ["SELECT 1; COMMIT; UPDATE probe SET v=1", false],
  ["SELECT 1;;", false], ["SELECT ';' AS value; /* tail */", true],
  ["SELECT $$; COMMIT; UPDATE probe$$;", true], ["SELECT $tag$;$tag$; -- tail", true],
  ["SELECT E'escaped\\\'; still quoted';", true],
  ["SELECT 1 /* outer /* nested ; */ done */;", true],
  ["SELECT 'unclosed", false], ["/* unclosed", false], ["SELECT $tag$unclosed", false],
];
for (const [statement, allowed] of pg) assert.equal(strictGuard(statement, "postgres"), allowed, statement);
const mysql = [
  ["SELECT 1; COMMIT; UPDATE probe SET v=1", "", false],
  ["/*!50000 DROP TABLE probe */", "", false],
  ["SELECT * FROM probe /*!50000 INTO OUTFILE '/tmp/escape' */", "", false],
  ["SELECT /*+ MAX_EXECUTION_TIME(99999) */ 1", "", false],
  ["SELECT 'INTO OUTFILE LOAD_FILE'", "", false],
  ["SELECT * INTO/**/OUTFILE '/tmp/escape' FROM probe", "", false],
  ["SELECT 'ordinary;string'; /* tail */", "", true],
  ["SELECT 1 AS `semi;name`; # tail;", "", true],
  [String.raw`SELECT '\' INTO OUTFILE '/tmp/escape' -- '`, "NO_BACKSLASH_ESCAPES", false],
  [String.raw`SELECT '\' AS value;`, "NO_BACKSLASH_ESCAPES", true],
  [String.raw`SELECT 1 AS "semi;name";`, "ANSI_QUOTES", true],
  [String.raw`SELECT 1 AS "x\"; DROP TABLE probe; -- "`, "ANSI_QUOTES", false],
  ["SELECT 1", null, true], [String.raw`SELECT '\\'`, null, false], ['SELECT "x"', null, false],
  ["SET @x=1", "", false], ["WITH c AS (SELECT 1) UPDATE probe SET v=1", "", true],
];
for (const [statement, mode, allowed] of mysql) assert.equal(combinedGuard(statement, mode), allowed, statement);
console.log(JSON.stringify({ label: "lexical-checks", passed: pg.length + mysql.length }));
