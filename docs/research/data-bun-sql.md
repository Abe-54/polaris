# Bun.SQL and a live sqllens schema

ENG-644 / ENG-649 · Task S · 2026-10-30. Research only; no product code.

**Bun.SQL works with both real databases, but the calling convention is a security boundary.**
Direct `unsafe(text)` accepts multiple statements and can escape a read-only transaction on
both engines. Use a tagged unsafe fragment, a lexical single-statement check, and a read-only
transaction. MySQL also needs the additional lexical and raw-text restrictions below: its DDL
implicitly commits, and its read-only transaction permits file output.

**sqllens-language-server 0.5.0 can complete tables and columns from a live schema.** The real
LSP test passed with catalogs read from both databases. Polaris's existing wrapper does not yet
supply that catalog; replacing sqllens with a Monaco completion provider is unnecessary.

## Reproduction and evidence

Run from the repository root, with Bun 1.4.4 and a running Docker engine:

```sh
bash docs/research/data-bun-sql/run.sh /tmp/polaris-data-bun-sql
```

The runner creates two disposable containers, loads 300 related tables plus fixtures and a
1,000,000-row table in each database, runs the probes, installs the pinned LSP in a temporary
directory, and removes its containers and anonymous volumes on exit. It never discovers or
uses a checkout's Data Sources. It uses fixed dummy fixture passwords; MySQL's plaintext RSA
key retrieval is explicitly enabled **only for these disposable loopback fixtures**. Use TLS
with authenticated server identity for real connections. The script needs registry access on
an uncached first run. `SPIKE_PG_PORT` / `SPIKE_MYSQL_PORT` override 56491 / 56492.
`SPIKE_ENGINE=podman` or `vmpal` selects the corresponding CLI; only Docker was exercised.

Observed command: `bash docs/research/data-bun-sql/run.sh /tmp/polaris-data-final`, exit 0.
`validate.mjs /tmp/polaris-data-final` was then added and run separately, exit 0; the runner
now invokes it too. Its first draft incorrectly classified a semicolon inside a `#` comment as
an escape; that expectation was corrected before the passing validation. The 27 local lexer
cases passed. Root typecheck passed with all 18 tasks cached; root lint passed. Product tests
were not rerun: no product package changed. These probes exercise real servers, not fakes.

Environment:

| Component | Observed |
|---|---|
| Host/runtime | macOS arm64; Bun 1.4.4, revision `38afee6c84fcf48c0edb2466aa4b27d287a59c30` |
| Containers | Docker Engine 29.4.0, OrbStack, Linux arm64 |
| Postgres | 16.15, Debian `16.15-1.pgdg13+2` |
| MySQL | 8.4.13 |
| LSP | `sqllens-language-server@0.5.0`, `sqllens@1.11.0`; isolated frozen dependency lock |

Docker was installed but OrbStack was stopped. VMPal Containers was also off. Starting the
installed OrbStack engine made Docker available; no VMPal settings were changed. Images are
pinned by digest in [run.sh](data-bun-sql/run.sh), not resolved from mutable tags on reruns.

Durable, unabridged statements, timings, values, errors and result metadata are in:

- [Postgres recording](data-bun-sql/recorded/postgres.ndjson)
- [MySQL recording](data-bun-sql/recorded/mysql.ndjson)
- [Postgres LSP recording](data-bun-sql/recorded/sqllens-postgres.ndjson) and [MySQL LSP recording](data-bun-sql/recorded/sqllens-mysql.ndjson)
- [Environment, image IDs and recording hashes](data-bun-sql/recorded/manifest.json)

Each NDJSON row has a `label`; `statements` contains the exact SQL. The SQL for fixture creation
is in [setup.mjs](data-bun-sql/setup.mjs). Failed exploratory assumptions are retained as observed
errors, including MySQL's unsupported `prepare: false` option.

## Single-statement execution: required on both engines

The supported composition below refused both tested multiple-statement strings before either
statement executed. This is an unsafe **SQL fragment**, not a parameterized value:

```js
await sql.begin("read only", async tx => {
  return await tx`${tx.unsafe(text)}`;
});
```

Test strings were `SELECT 1; UPDATE probe SET v=71 WHERE id=1` and, crucially,
`SELECT 1; COMMIT; UPDATE probe SET v=72 WHERE id=1`. The latter persisted `v=72` through every
direct-unsafe variant below, on **both** databases. The fixture was reset between variants.

| Invocation | Rejects COMMIT escape? |
|---|---|
| `unsafe(text)` | No |
| `unsafe(text, [])` | No |
| `unsafe(text, [], { prepare: true })` | No; third argument is not a supported option |
| `new SQL(url, { prepare: true })`, then direct `unsafe(text)` | No |
| `new SQL(url, { multipleStatements: false })`, then direct `unsafe(text)` | No; option is unsupported/ignored |
| `` tx`${tx.unsafe(text)}` `` | **Yes**; Postgres `ERR_POSTGRES_SYNTAX_ERROR`, errno `42601`; MySQL `ERR_MYSQL_SYNTAX_ERROR`, errno `1064`, SQLSTATE `42000` |

Postconditions for the tagged path were `v=0` after each rejected string. No extra dependency or
driver fork is needed. Keep `prepare` enabled and never call `.simple()` on user/agent SQL.
The exact tested path has no bind parameters; X must also regression-test its parameterized
composition. Bun's API supports nesting `unsafe(text, params)` in the tagged query, with the
documented Postgres restriction that its `$1` must be the outer query's first parameter.

Pinned Bun [unsafeQuery source](https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/js/bun/sql.ts#L157)
sets simple mode for missing **or empty** values. This explains why `[]` does not help.
The third argument cannot carry `prepare` or an AbortSignal: the function accepts two arguments.

X must additionally tokenize and reject every semicolon except one optional trailing one.
The research [lexer](data-bun-sql/lexical.mjs) and [27 cases](data-bun-sql/lexical-checks.mjs)
cover quotes, doubled/escaped quotes, PG dollar quotes and nested comments, MySQL backticks,
`--` / `#` / block comments, executable comments and SQL modes. They are a reproducible probe,
not a production parser. PG string lexing must agree with `standard_conforming_strings`; the
local PG cases assume its default `on` and recognize `E'…'` escapes. The tested prepared path
provides the independent server-side single-statement boundary.

## Read-only transactions

Connections were made with `new SQL(url, { max: 1, idleTimeout: 0, … })`. Both URL adapters
connected successfully. Inside `sql.begin`, Postgres accepted `SET TRANSACTION READ ONLY` and
MySQL accepted `START TRANSACTION READ ONLY`. Prefer `sql.begin("read only", callback)` on both:
it also rejected UPDATE, and avoids starting a second MySQL transaction inside the first.

| Exact probe | Postgres | MySQL |
|---|---|---|
| `INSERT INTO probe VALUES (2, 1)` | `25006` | `1792` / `25006` |
| `UPDATE probe SET v = 1 WHERE id = 1` | `25006` | `1792` / `25006` |
| `CREATE TABLE forbidden (id INT)` | `25006` | **Succeeded and persisted** |
| `SELECT nextval('probe_seq')` | `25006` | `1305` / `42000`: function does not exist; not a read-only test |
| `SELECT * FROM probe FOR UPDATE` | `25006` | `1792` / `25006` |
| PG: `WITH changed AS (UPDATE probe SET v = 2 RETURNING *) SELECT * FROM changed` | `25006` | PG-style writable CTE is not MySQL syntax |
| MySQL: `WITH chosen AS (SELECT 1 AS id) UPDATE probe SET v = 2 WHERE id IN (SELECT id FROM chosen)` | — | `1792` / `25006` |

PG's `code` was `ERR_POSTGRES_SERVER_ERROR`, with SQLSTATE in string `errno` (for example
`"25006"`). MySQL's `code` was `ERR_MYSQL_SERVER_ERROR`, numeric `errno`, separate `sqlState`.
Do not classify only by the JavaScript error class or by one engine's representation.

MySQL `SET TRANSACTION READ ONLY` **inside** an already started transaction failed with `1568` /
`25001`. Both the explicit-start path and `begin("read only")` allowed CREATE TABLE. The table
existence query confirmed both `forbidden` and `forbidden_option` after the callbacks returned.
This agrees with MySQL's [implicit-commit rules](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html).

### MySQL combined guard, as decided by the Lead

Use all of these, together, for query and describe samples:

1. Single-statement prepared path above, plus lexical single-statement validation.
2. `begin("read only")`; first keyword after comments/leading parentheses must be SELECT, WITH,
   TABLE, VALUES, SHOW, DESCRIBE/DESC or EXPLAIN. Reject other forms as `E-DATA-READ-ONLY`.
3. Reject raw `/*!` anywhere. This probe also **rejects optimizer hints `/*+`** conservatively;
   they were not accepted as a supported safe subset.
4. Reject raw OUTFILE, DUMPFILE or LOAD_FILE case-insensitively, including inside literals and
   comments. These intentional false positives close the demonstrated file escapes.
5. Read `@@session.sql_mode` once on **each physical pooled connection**, and lex with
   NO_BACKSLASH_ESCAPES and ANSI_QUOTES. If reading it fails, reject backslashes and double quotes.

[mysql-guard.mjs](data-bun-sql/mysql-guard.mjs) executes the original weaker proposal for contrast,
then executes only statements accepted by the combined guard. Its `combinedAllowed` field records
every decision. The full per-statement matrix follows below. No product implementation is claimed.

Two concrete counterexamples to merely stripping comments/literals:

```sql
SELECT * FROM probe /*!50000 INTO OUTFILE '/var/lib/mysql-files/spike-versioned.csv' */
-- with NO_BACKSLASH_ESCAPES:
SELECT '\' INTO OUTFILE '/var/lib/mysql-files/spike-mode.csv' -- '
```

Both wrote files through a tagged single statement inside `BEGIN READ ONLY`. Reading the files
back returned bytes `[49,9,48,10]` and `[92,10]`. The combined guard rejected both before dispatch.
`SELECT /*!50000 LOAD_FILE('/etc/hostname') */ AS contents` also passed the old guard; the server
returned NULL under this container's file restrictions. It is **not** evidence the old guard is safe.

The stored function `spike_write()` tried `UPDATE probe SET v=99`; `SELECT spike_write()` passed
the keyword guard but failed at the transaction barrier (`1792` / `25006`), leaving `v=0`.
Defining a function containing CREATE TABLE failed with `1422` / `HY000` (implicit/explicit commit
forbidden in stored functions); invoking that nonexistent function then failed with `1305`.
DDL, CALL, SET, DO, HANDLER, LOCK TABLES, XA and PREPARE/EXECUTE were all rejected by the guard.
This is a finite adversarial matrix on privileged fixtures, not a proof against arbitrary installed
UDFs, extensions or external side effects.

Recommended later hardening: a dedicated, least-privilege SELECT-only principal per Data Source
(the Lead placed an optional “agent user” setting outside v1). The tested `spike_reader` principal,
granted SELECT only, rejected CREATE and UPDATE with `1142` / `42000`. Do not use that recommendation
as a replacement for implementing the decided v1 guard.

### Shared locks are real, but released on completion

MySQL rejected FOR UPDATE but **accepted LOCK IN SHARE MODE and FOR SHARE** inside read-only.
Each held a real shared lock: a second connection's UPDATE timed out with `1205` / `HY000`
while the transaction remained open. Immediately after commit, UPDATE succeeded in 7.32 ms /
6.11 ms. For `SELECT id,SLEEP(0.6) AS slept FROM probe …`, the reader returned in 603.11 / 606.65 ms;
the writer started about 100 ms into it, waited 501.17 / 508.68 ms, and completed just after commit.
These clauses meet the Lead's release-on-completion condition **only if X ends the transaction
before returning the Query result**, including cancellation/error paths. A slow query holds the
lock for its duration; do not leave a cursor or result drawer holding a transaction open.

## Statement timeout and cancellation

PG: within `begin`, `SET LOCAL statement_timeout = '100ms'` interrupted both `SELECT pg_sleep(1)`
and `UPDATE probe SET v = 4 FROM pg_sleep(1)` in 101.66 / 110.48 ms. Both returned errno `57014`,
message `canceling statement due to statement timeout`. `SHOW statement_timeout` afterwards was
`0`: LOCAL did not leak. Use 30,000 ms for the contract, with a client deadline as a backstop.

MySQL: `SET SESSION max_execution_time = 100` interrupted
`SELECT SUM(a.id*b.id) AS total FROM million a CROSS JOIN million b` in 130.23 ms, errno `3024`,
SQLSTATE `HY000`. `DO SLEEP(0.4)` and an UPDATE containing `SLEEP(0.4)` still took about 400 ms.
`BENCHMARK(...)` was a misleading probe: it stopped around 100 ms but returned `0`, not a timeout
error. Do not use successful BENCHMARK/SLEEP results as proof a hard deadline is enforced.
MySQL documents the [SELECT-only scope](https://dev.mysql.com/doc/refman/8.4/en/server-system-variables.html#sysvar_max_execution_time).

| Client action, 100 ms into a 1 s query | Postgres | MySQL |
|---|---|---|
| `query.cancel()` | `57014`, user-request message, 105.06 ms | **Query still resolved at 1005.94 ms**, `cancelled=true` |
| Extra `signal` argument to `unsafe` | Ignored; resolved at 1005.45 ms | Ignored; resolved at 1005.11 ms |
| `sql.close({ timeout: 0 })` | Client rejected with `ERR_POSTGRES_CONNECTION_CLOSED` | Client rejected with `ERR_MYSQL_CONNECTION_CLOSED` |
| `.cancel()` before execution | `ERR_POSTGRES_QUERY_CANCELLED` | `ERR_MYSQL_QUERY_CANCELLED` |

An AbortSignal is supported for **waiting on `reserve({ signal })`**, not for canceling an active
query. The extra argument test verifies ignoring it, not a supported cancellation API. Pool close
demonstrates client rejection only; this probe does not claim it stops server work immediately.

For a real MySQL non-SELECT deadline, an active-query timer on a separate control connection
issued `KILL QUERY <CONNECTION_ID()>`. A 2 s UPDATE was interrupted in 107.01 ms with `1317` /
`70100`; `begin` rolled back, and `v` stayed 0. X needs this backstop for commands outside SELECT
and cases in which SELECT timeout is insufficient. Reserve the target connection until kill and
rollback settle; otherwise a late KILL can cancel its next borrower. Clear timers in `finally`;
they exist only while a Query is active. The probe used root, so deployments must check the
control user's [KILL permissions](https://dev.mysql.com/doc/refman/8.4/en/kill.html) and TLS/proxy behavior.

## Row caps and memory

Bun 1.4.4's Query has no `.cursor()` (runtime value `undefined`). `.values()` and `.raw()` change
representation; both still buffer the whole result. Each measurement below ran in a fresh Bun
child, over one million `{ id, payload: repeat('x',64) }` rows. Peak is
`process.resourceUsage().maxRSS / 1024` MiB; delta subtracts that child's pre-query high-water mark.
These are one-run local measurements, not a Pi/quiet-host regression baseline.

| Method | PG peak / delta MiB | MySQL peak / delta MiB | Rows materialized |
|---|---:|---:|---:|
| Buffered tagged query | 180.80 / 173.45 | 185.53 / 178.06 | 1,000,000 |
| `.values()` | 191.30 / 183.91 | 194.61 / 187.20 | 1,000,000 |
| `.raw()` | 257.17 / 249.67 | 287.91 / 280.47 | 1,000,000 |
| Derived-table LIMIT 201 | 7.45 / 0.02 | 7.36 / 0.08 | 201 |
| SQL cursor, FETCH 512 until exhausted | 25.77 / 18.44 | Not available as standalone SQL | 512 per fetch, 1M consumed |
| SQL cursor, stop after first fetch | 7.61 / 0.14 | — | 512 |

The tested wrapper was exactly
`SELECT * FROM (SELECT id, payload FROM million) AS polaris_capped LIMIT 201`.
Return the first 200; row 201 establishes truncation. This caps rows **returned**, not server work
or individual cell bytes, and provides no exact total. Never label a capped result “200 of N”
unless N came from a separate count/known source; use “200 rows; more available” otherwise.

Postgres's native [SQL cursor](https://www.postgresql.org/docs/16/sql-declare.html) works through Bun:
`DECLARE … NO SCROLL CURSOR FOR …`, FETCH, CLOSE, all within one transaction. X can fetch limit+1
then close/commit immediately. User SQL must enter DECLARE through the verified tagged path and
lexical check, not by concatenation into a simple-protocol batch.

For MySQL SELECT/WITH query expressions, prefer the tested LIMIT wrapper after single-statement
validation. It is **not** a general wrapper for SHOW, DESCRIBE, EXPLAIN or arbitrary SQL. Bun exposes
no general MySQL row cursor here. X must handle those allowed command forms separately with an
explicit bounded strategy or reject unsupported forms; silently buffering and slicing is not the
contract's memory cap. Likewise do not append LIMIT blindly after a trailing semicolon/comment.

## Values and headers

The fixture decimal was `12345678901234567890.12345678901234567890`; bigint was
`9223372036854775807`; JSON contained numeric token `9007199254740993`. First and reused prepared
queries were both exercised, alongside values/raw/simple-raw and `bigint: true` variants.

| DB type | Bun's normal value | Rendering for data-tools-v1 |
|---|---|---|
| PG numeric / MySQL decimal | Exact decimal **string**, including scale | Preserve string; never Number/parseFloat |
| bigint, both | String for the large fixture; `bigint:true` returns BigInt | Decimal string for text and JSON transport |
| PG timestamptz | Date: `2026-10-30T07:04:56.123Z` | ISO offset; default Date loses fixture's final 456 microseconds |
| PG json/jsonb; MySQL JSON | Parsed object; fixture rounds to `9007199254740992` | Default is lossy; keep raw JSON text/lossless numeric tokens, compact without Number conversion |
| PG bytea / MySQL BLOB | Buffer `00ff4142`, length 4 | `<bytes 4>` |
| PG int[] / text[] | JS arrays, preserving NULL element | Typed array display/compact JSON, preserve numeric element precision |
| PG uuid; MySQL CHAR(36) uuid fixture | String | String; MySQL has no native uuid/array fixture type |
| PG / MySQL enum | String `calm` | String; declared enum type comes from catalog |
| MySQL DATETIME(6) | Date `2026-10-30T12:34:56.123Z` | It has no inherent timezone; do not invent one from the returned Date |
| MySQL TIMESTAMP(6) | Date, same .123 millisecond truncation | Set/know connection timezone; preserve microseconds from raw data if required |
| MySQL BIT(8) | Buffer `81` | `<bytes 1>` under v1 binary rule; a future bit display must be type-aware |
| MySQL TINYINT(1) | Number **2** | Numeric, never coerce to boolean |
| float8 / DOUBLE | JS Number `1.2345678901234567` | Already IEEE-754 in DB; don't route exact decimal types through this conversion |
| NULL | JS null | `NULL` |

For precision beyond normal values, `.raw()` preserves protocol bytes. They are **not always
UTF-8 strings**: prepared PG numeric/timestamptz/int[]/float8 and MySQL bigint/date/tinyint/double
were binary. PG numeric began `000a000400000014…`; MySQL bigint was `ffffffffffffff7f`.
JSON/jsonb bytes remained text with the original `9007199254740993` token on both.
`.simple().raw()` produced text for these types, but must never be used to execute arbitrary
user SQL. PG `prepare:false` also produced text; MySQL refused it with `ERR_INVALID_ARG_VALUE`.

X needs a type-aware boundary serializer if it promises exact JSON numbers and microseconds.
Default values suffice for decimal/bigint but **not** the complete value contract. A PG cursor's
controlled FETCH can retrieve text via raw/simple without putting user SQL on that path. For
MySQL prepared raw, decode by type code, flags and protocol representation. Clip strings to
200 characters only at formatting, reporting omitted characters; compact JSON without a lossy
JSON.parse/stringify round trip. Timestamp offset policy for timezone-free DATETIME needs explicit
handling, not an assumption that the driver-created Date established an offset.

**Bun exposes result column metadata**, including empty results and duplicate names with
`.values()`: `result.columns`.
These properties are prototype accessors, so Object.keys / JSON.stringify on the result array
omit them; the probe reads them explicitly. Do not infer header types from JS values.

PG columns report `name`, type OID, source table OID and attribute number. Resolve distinct OIDs
using `pg_type` / `format_type(oid,NULL)`; for declared precision/scale use source pg_attribute's
atttypmod with format_type. Expressions have no source attribute, so don't invent typmods.
The fixture exposed numeric 1700, bigint 20, timestamptz 1184, JSON 114, JSONB 3802, bytea 17,
int[] 1007, text[] 1009, uuid 2950 and the database-assigned enum OID.

MySQL columns report protocol `type`, `table` (potentially an alias), `length`, `flags`.
Examples: DECIMAL 246, BIGINT 8, TIMESTAMP 7, DATETIME 12, JSON 245, BIT 16, TINYINT 1;
enum used STRING 254 plus enum flag 256. BLOB and TEXT shared code 252 with different flags.
Map codes/flags for result headers; information_schema.COLUMNS.COLUMN_TYPE supplies full declared
types for known table columns. Expression/alias metadata cannot reconstruct every declaration.

## SchemaTree / TableDetail on 300 tables

[introspection.mjs](data-bun-sql/introspection.mjs) contains the exact runnable queries. Five
sequential runs per query used one connection; first is the first client call, “warm” is the median
of the next four, not a controlled cold-cache benchmark. No COUNT(*) scans are used for estimates.

| Catalog query | PG first / warm ms | MySQL first / warm ms |
|---|---:|---:|
| Tree + column counts + estimates | 1.947 / 1.217 | 293.139 / 6.011 |
| Columns / defaults / primary key | 0.743 / 0.303 | 0.645 / 0.426 |
| Constraints / FK source and target | 0.745 / 0.415 | 3.463 / 2.370 |
| Indexes | 0.337 / 0.262 | 0.868 / 0.373 |
| Functions | 0.904 / 0.423 | 1.107 / 0.399 |
| Function parameters / result | Included above | 0.494 / 0.314 |

The tree returned 304 PG / 308 MySQL objects including the 300 numbered tables and probe fixtures.
Assertions verify all 300 tables, four t_0 columns, a real FK targeting probe and the fixture
function. t_0 has a primary key, label index, FK and check; MySQL also creates an FK-support index.
PG FK column arrays preserve ordinal pairing. MySQL joins TABLE_CONSTRAINTS, KEY_COLUMN_USAGE,
REFERENTIAL_CONSTRAINTS and CHECK_CONSTRAINTS, retaining constraint identity and column order.
Functions include PG identity arguments/results and MySQL PARAMETERS (return at ordinal 0).

PG estimates use pg_class.reltuples: `-1` was observed for unanalyzed tables/views, and must render
as unknown, not negative rows. Analyzed t_0 estimated 1. MySQL TABLES.TABLE_ROWS was approximate
(for example, below 1M for million) and NULL for the view. Never present either estimate as exact.
Probe filters intentionally scope to public/current database. For production, enumerate visible
user schemas, parameterize requested schema/table, quote identifiers correctly, and respect the
Data Source's database boundary; do not copy the hard-coded fixture regclass into general input.

## Pools and idle behavior

Use a lazy, small `new SQL(url, { max: 2, idleTimeout: …, maxLifetime: 0 })` per resolved Data Source.
The probe ran eight concurrent transactions and observed exactly two connection IDs per pool;
a second SQL instance got a distinct ID. Both connections closed about one second after the
batch ended: PG `ERR_POSTGRES_IDLE_TIMEOUT`, MySQL `ERR_MYSQL_IDLE_TIMEOUT`. A subsequent Query
connected successfully. Re-resolved credentials/target changes must invalidate the old pool.

Native [ConnectionTimers in Bun 1.4.4](https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/sql_jsc/shared/ConnectionTimers.rs)
uses one-shot event-loop deadlines: reset removes/reinserts; a fired idle timeout closes the
connection. A zero maxLifetime leaves that timer unarmed. There is no repeating pool poll in
that implementation; idleTimeout defaults to 0, so configure it explicitly. The JS timeout in
sql.close is a one-shot grace deadline, not an idle polling loop.

Measured process CPU over 2.2 s after idle close: PG user 1606 µs / system 1725 µs; MySQL user
1170 µs / system 1298 µs. This is observational support, **not** an OS wakeup count or the idle
Daemon bench. X still owns its before/after idle benchmark and cancellation cleanup. Do not add
a cleanup interval: driver idle deadlines and close on eviction suffice.

## ENG-649: live schema completion

The catalog pins [sqllens-language-server 0.5.0](../../apps/daemon/src/languages/catalog/catalog.json)
and its dependency evidence pins sqllens 1.11.0. The npm server artifact matched the catalog's
SHA-512 integrity; its package metadata names git commit `4af40e9cfc8faf959883095f885c54ec3165bff1`.
The installed server exports `startServer(connection, { schema?: SchemaProvider })`; its
[pinned README](https://github.com/NiclasOlofsson/sqllens-language-server/blob/4af40e9cfc8faf959883095f885c54ec3165bff1/README.md)
documents the injection. This was confirmed on the published package, not inferred from latest docs.

[sqllens.mjs](data-bun-sql/sqllens.mjs) queries live information_schema.COLUMNS, constructs a
`new Schema(mapping)`, passes it to the **real server**, opens documents and sends real LSP
textDocument/completion requests over connected streams. On each engine:

- `SELECT * FROM t_`, cursor 16: **300 table suggestions**, including t_0, with correct text edits.
- `SELECT p. FROM t_0 p`, cursor 9: **id, parent_id, label, amount**, with type details.
- A cold CallbackSchema enumerated no tables; after resolving/priming t_0 it enumerated only t_0,
  version 1. A lazy resolver alone cannot offer names it has never been given.

The existing [Daemon wrapper](../../apps/daemon/src/languages/sql/server.txt) calls startServer with
only userConfigPath, forces a managed root, and has no Data Source catalog channel. Its launch
also disables project plugins. The [Desktop SQL module](../../apps/desktop/src/renderer/features/editor/sql/)
currently stores/selects dialects, not schemas. Thus the answer is **yes at the pinned dependency;
not wired in the current product**. No live database URLs or credentials should reach the LSP.

Smallest route: feed the chosen Data Source's Daemon-owned SchemaTree/TableDetail metadata into
the existing wrapper's SchemaProvider. Seed table enumeration from SchemaTree; resolve columns
from the describe cache and version/invalidate on source/schema changes. Keep selection isolated
per SQL document: startServer's single injected provider applies to every document, so mixed-source
files need per-source server isolation or a wrapper change, not one global “current source” map.
Then keep using existing LSP completion and alias resolution. A separate Monaco provider is a
fallback only if the managed-process bridge cannot carry catalog updates; it would duplicate SQL
context/alias handling. Posting the ENG-649 comment and product integration remain the Lead/U3 work.

## MySQL escape matrix

“Original” is the initial strip-comments/literals proposal; “combined” includes the Lead's later
raw denylist, executable-comment/hint rejection, SQL-mode agreement and single-statement check.
Server outcome is from the original accepted path; combined re-executes only allowed entries.
Rejected statements are never sent by the combined path. Syntax errors below come from the
prepared server boundary. All statements and both execution paths are retained in the recording.

| SQL | Original | Combined | Server outcome |
|---|---|---|---|
| `SELECT * FROM probe` | Allow | Allow | Succeeded |
| `/* ordinary */ ((SELECT * FROM probe))` | Allow | Allow | Succeeded |
| `WITH c AS (SELECT 1) SELECT * FROM c` | Allow | Allow | Succeeded |
| `TABLE probe` | Allow | Allow | Succeeded |
| `VALUES ROW(1)` | Allow | Allow | Succeeded |
| `SHOW TABLES` | Allow | Allow | Succeeded |
| `DESCRIBE probe` | Allow | Allow | Succeeded |
| `DESC probe` | Allow | Allow | Succeeded |
| `EXPLAIN SELECT * FROM probe` | Allow | Allow | Succeeded |
| `CREATE TABLE guard_created (id INT)` | Reject | Reject | Not dispatched |
| `DROP TABLE guard_target` | Reject | Reject | Not dispatched |
| `CALL spike_proc()` | Reject | Reject | Not dispatched |
| `SET @guard=1` | Reject | Reject | Not dispatched |
| `DO SLEEP(0.1)` | Reject | Reject | Not dispatched |
| `HANDLER probe OPEN` | Reject | Reject | Not dispatched |
| `LOCK TABLES probe WRITE` | Reject | Reject | Not dispatched |
| `XA START 'spike'` | Reject | Reject | Not dispatched |
| `PREPARE s FROM 'DROP TABLE guard_target'` | Reject | Reject | Not dispatched |
| `EXECUTE s` | Reject | Reject | Not dispatched |
| `/*!50000 DROP TABLE guard_target */` | Reject | Reject | Not dispatched |
| `SELECT * FROM probe FOR UPDATE` | Allow | Allow | 1792 |
| `SELECT * FROM probe LOCK IN SHARE MODE` | Allow | Allow | Succeeded |
| `SELECT spike_write()` | Allow | Allow | 1792 |
| `SELECT spike_ddl()` | Allow | Allow | 1305 |
| `WITH c AS (SELECT 1) UPDATE probe SET v=99` | Allow | Allow | 1792 |
| `SELECT * INTO OUTFILE '/var/lib/mysql-files/blocked.csv' FROM probe` | Reject | Reject | Not dispatched |
| `SELECT * INTO DUMPFILE '/var/lib/mysql-files/blocked.dump' FROM probe` | Reject | Reject | Not dispatched |
| `SELECT LOAD_FILE('/etc/passwd')` | Reject | Reject | Not dispatched |
| `SELECT 'INTO OUTFILE LOAD_FILE' AS harmless` | Allow | Reject | Succeeded |
| `SELECT * FROM probe /*!50000 INTO OUTFILE '/var/lib/mysql-files/spike-versioned.csv' */` | Allow | Reject | Succeeded |
| `SELECT /*!50000 LOAD_FILE('/etc/hostname') */ AS contents` | Allow | Reject | Succeeded |
| `SELECT * FROM probe INTO/**/OUTFILE '/var/lib/mysql-files/blocked-gap.csv'` | Reject | Reject | Not dispatched |
| `SELECT 1; DROP TABLE guard_target` | Allow | Reject | 1064 |
| `SELECT /*+ MAX_EXECUTION_TIME(10000) */ 1` | Allow | Reject | Succeeded |
| `SELECT 'ordinary;string' AS value; /* trailing comment */` | Allow | Allow | Succeeded |
| ``SELECT 1 AS `semi;name`;`` | Allow | Allow | Succeeded |
| `SELECT 1 # ; DROP TABLE guard_target` | Allow | Allow | Succeeded |
| `SELECT * FROM probe FOR SHARE` | Allow | Allow | Succeeded |
