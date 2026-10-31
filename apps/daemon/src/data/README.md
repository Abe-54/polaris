# Checkout Data Sources (ENG-644)

`DataSources.layer` uses EventStore only to read `record.session.cwd`, HostSecrets to keep
manual-source passwords, and `DataSourceAccess` to attach approval state. Sessions in the same
checkout share stable ids (SHA-256 of the real checkout path + NUL + name), manual sources and labels.
The access policy reads local sources and applies remembered approvals to remote sources. It is independent of the Engine so the Engine, MCP and RPCs share one instance.

`list` and `resolve` read configuration afresh; no polling, cross-request cache or extra file watcher is installed.
`watch` subscribes before reading its snapshot, then updates on manual-source and label mutations.
Filesystem edits are reflected on the next request, watch subscription or explicit internal refresh.
Discovery omits `reachable` until a connection is tried; it performs no database connection probe.

Discovery reads the root environment files listed below, root/`prisma/schema.prisma`, root `drizzle.config.{ts,js,mjs}`,
Rails `config/database.yml` development, root or one-directory-deep Django `settings.py`, and the
four compose filenames. Environment precedence, lowest first: `.env`, `.env.local`,
`.env.development`, `.env.development.local`. Production, staging and test are separate sources
(`app (production)`); examples, samples, templates, vaults and keys are ignored. A key has one
source; an env reference from Prisma/Drizzle does not duplicate it. DATABASE_URL is named `app`;
other keys and compose services are lowercased. Manual sources shadow discovery by name.

Framework discovery reads literals only; it never imports or executes a checkout's code. Django
and Drizzle targets with dynamic fields are skipped. Rails supports YAML aliases and literal
`ENV["KEY"]` interpolation from checkout env files, but does not run ERB. Compose requires a
published database port and maps a matching container hostname to the Host's published port.

Discovered URLs exist only in memory. `resolve({sessionId, source})` accepts a name or stable id
and returns `{source, connection, matchUrl}` internally. The matching URL and connection password are Redacted.
`matchUrl` is for outside-command matching only, never for connecting. Execution passes the explicit connection fields (with `adapter: source.engine`), never the URL, to
Bun.SQL: Bun 1.4.4's URL constructor lets PGDATABASE change an explicit URL's database.
Postgres query parameters host/port/user/dbname/password override authority fields; socket/path
and TLS modes are resolved explicitly. Ambiguous repeated target parameters are skipped.

`data.sqlite` stores manual metadata and labels in separate tables, not in the event log. Its
mode is 0600. Passwords live only under `data/<id>` in HostSecrets, base64-encoded at this
namespace boundary so spaces, quotes and Unicode pass the existing token validator. Other
secret namespaces retain their validation. The empty password uses `=` as its encoded token.
Errors report constant text and never include parser, SQLite or Secure Storage error details.

Discovery only reads regular files up to 64 KiB, opened with `O_NOFOLLOW | O_NONBLOCK`, after
checking their real path remains in the real checkout. Parsing is literal and bounded; Prisma
uses a single forward scan. Discovery has a two-second request timeout and runs outside the
storage lock. No timer or watcher runs while idle.

Loopback and Unix sockets start remote. At every list/resolve, a request-scoped owner probe uses
macOS lsof (the executable text mapping, not the process title) or Linux socket inodes and
`/proc/*/fd`. Only postgres, mysqld and mariadbd owners count as database servers. Docker/OrbStack
proxies additionally need a running database container whose compose working-directory label is
this real checkout and whose published port matches. Missing owners, permission failures, timeouts,
tunnels and unknown executables remain remote and need approval. This is a resolve-time observation;
X re-resolves the target before use. There is no periodic owner polling.

Stored label overrides carry an engine/host/port/database/user target fingerprint. A mismatch
removes the override permanently and restores `defaultLabel`. Legacy labels without a fingerprint
are dropped. Manual edits must name `previousName`; an existing name cannot be implicitly replaced.
`keep` is accepted only for an unchanged engine, host, port and user. New sources with no password
clear any old orphan; failed metadata saves restore the previous secret or remove the copied one.

## Shapes for consumers

- `resolve` returns `{source, connection, matchUrl}`. `matchUrl` is for matching only and must never
  be passed to a driver. Build scrub inputs from `connection.password`, including `?password=`.
- `DataSource.reachable` is optional: absent means unprobed, false means a connection failed, true
  means a connection succeeded. The Desktop App must not display absent as unreachable.
- `DataSources.refresh({sessionId})` is internal, returns the same `DataSource[]` as `list`, and
  publishes a checkout change to existing watches. X calls it before opening a Data Source Approval,
  then resolves again so approval and connection use the refreshed target.
- The Desktop App re-subscribes `data.sources.watch` on Data focus and before showing source approval
  details; subscription always re-lists and probes. No new refresh RPC is needed.

## Execution

`DataQueries` is shared by the agent tools and Client RPCs. `transport/serve.ts`
provides discovery, access policy, approvals and the Query Log once below the Engine.
`services.test.ts` exercises that production composition through agent calls and RPCs
in a child with its own `POLARIS_HOME`.

Connections use the explicit fields returned by `DataSources.resolve`, including a
Redacted password. Bun never receives the URL, so inherited `PG*` or `MYSQL_*`
variables cannot redirect the target. Pools are lazy, bounded to 16 targets, with two
query connections and one cancellation connection per target. Bun closes idle
connections after five seconds; there is no Data polling interval.

Every read runs in a read-only transaction. The lexer enforces one statement and
MySQL's verified restrictions before the statement reaches the prepared path.
Postgres reads use a cursor and one capped FETCH; MySQL reads use a derived-table
LIMIT. Both fetch one extra row to establish truncation. MySQL SHOW, DESCRIBE/DESC
and EXPLAIN are refused because their output cannot be bounded through this path;
use the metadata-only `describe` tool. The active-query deadline is 30 seconds.
MySQL cancellation uses a separate connection to issue KILL QUERY and holds the
query reservation until cancellation and rollback settle.

Raw values preserve numeric, JSON and timestamp precision before credential
scrubbing and per-cell clipping. The agent Query is capped at 200 rows and 16,000
characters; Client streams allow 10,000 rows, with chunks bounded by encoded bytes
and row count. This bounds returned rows, not the amount of database work needed
to produce them. A large individual value is received from the driver before it is
clipped. The stream sends bounded chunks after the capped database read completes.

Remote agent reads use the Agent Session machine's Data Source Approval. The
request records only target metadata, and `RespondToApproval` records the decision.
`ApprovalStore` replays those durable events into `data.sqlite`, with an atomic replay
cursor. Exact target decisions include engine, host, port, database and user;
whole-server decisions include engine, host and port. Revocation overrides a broader
server grant for the exact target. Ending a Turn withdraws pending cards through the
existing machine lifecycle, and waiters receive a denial. A timed-out wait leaves
the card pending.

The Query Log retains the latest 10,000 entries per checkout. Remote entries contain
SQL and attribution, but never bound parameters or result rows. Approval outcomes
are joined from the durable approval projection. Outside-Polaris entries are
idempotent by Agent Session and tool item id.

### Execution checks

```sh
bun test apps/daemon/src/data apps/daemon/src/verification/dataApprovals.model.test.ts
bun run spec
```

The database regression tests skip unless their engine's variable is set. Use only
throwaway Postgres 16 and MySQL 8.4 databases: the fixture creates tables, functions
and one million rows, then removes its objects. The MySQL fixture needs CREATE
ROUTINE permission and a configuration allowing its test stored function.

```sh
POLARIS_TEST_PG_URL='<disposable Postgres URL>' \
POLARIS_TEST_MYSQL_URL='<disposable MySQL URL>' \
bun test apps/daemon/src/data/execution.real.test.ts
```

The checks cover the guard matrix, database rejection of a write inside a function,
bound parameters, 200/10,000-row caps, timeout, cancellation, subsequent connection
use, explicit connection options overriding PGHOST/PGDATABASE, and catalog reads.
Real database results and idle benchmark results belong in the delivery receipts;
unit tests alone do not establish them.

Catalog reads decode MySQL binary-collated catalog fields as UTF-8 text; ordinary Query
results still summarize binary values as bytes. Catalog JSON columns accept tagged JSON
and JSON text arrays. Invalid metadata returns `E-DATA-SQL` naming the engine and field,
without including the raw value. `catalog.test.ts` covers these driver value shapes and
field-specific failures; the live suite also checks views, routines, defaults, indexes
and check constraints.

## Writes (ENG-645)

`DataQueries.execute` uses the same pools, single-statement lexer, transaction deadline and
cancellation boundary as reads. A preview runs in a writable transaction and is rolled back
before `data.approvalRequested` opens a write card. `RespondToApproval` decides that card;
ending the Turn, stopping the Agent Session, or recovery denies pending cards. Remote execute
requires remembered read access for the exact target or server **as this user**, and writes set
to `ask`; a one-request read approval cannot authorize a preview. Each write still needs its
own approval, regardless of the Session's permission mode or `remember` choice.

An explicit `execute.requestId` binds a retry to its Agent Session and durable argument hash.
Completed receipts are returned before checking for an active Turn or opening the source.
A different payload under the same key is refused; a different key requests a separate write.
Uncompleted approvals remain bound to their original Turn. Calls without a key retain the
exact-argument, per-Turn fingerprint.

Without a requestId, a fingerprint binds the Agent Session, Turn, source id, target, SQL, parameters and reason.
Retries share one card. A durable compare-and-set consumes approved authority before the
transaction starts, and a completed retry returns the original result. Concurrent retries
cannot execute twice. If a process or connection fails after consumption, automatic replay is
refused: inspect the Query Log and database before requesting another write. This is an
at-most-once dispatch guarantee, not an atomic commit spanning SQLite and an external database.

The real transaction must affect exactly the previewed count or it rolls back. UPDATE/DELETE
previews read up to 20 rows, ordered by primary key; UPDATE after-rows use the original keys.
The card is capped at 16,000 bytes of row data, with the existing per-cell clipping. Tables
without a primary key show the count and say why rows aren't shown. Preview values are scrubbed
only for display; subsequent key lookups bind original values. A resolved table is qualified in
the statement and its metadata is locked through the transaction.

`data.edits.commit` groups staged cells by their primary-key tuple. It verifies the actual
primary key, updates each row once, requires one matched row per update (including MySQL
no-op assignments), and rolls back the entire batch on any mismatch. Its one Query Log entry
has author `user`. Completed writes carry `affected: [{schema, table, rows}]` for exact target
attribution; read result counts never populate that field. Clients negotiate `data.writes`
before sending this RPC. The Desktop App owns the remote bulk confirmation.

### Write limits (ENG-669)

- INSERT, UPDATE and DELETE must name one explicit table. Read-only subqueries in SET/WHERE
  and INSERT … SELECT are supported. Joins, aliases, CTEs, RETURNING, ORDER/LIMIT and tuple
  assignments are refused with rewrite or migration guidance.
- Primary-key assignments are refused. A trigger that moves a sampled key also makes the
  preview or real transaction roll back when after-rows cannot be read. Change keys through
  a migration or the app's own code, not execute.
- DDL is local Postgres only. MySQL DDL commits implicitly and cannot be previewed; remote
  DDL is refused. MySQL row writes require an InnoDB target, checked under its metadata lock.
- Rollback protects transactional rows, not every effect of executing SQL. Sequences (including
  `nextval` and auto-increment allocation) can advance. External or independently committed
  effects in user functions/triggers can survive; a restricted database role remains necessary.
  Non-InnoDB writes survive rollback, which is why those targets are refused. PostgreSQL NOTIFY
  is transactional and is not delivered on rollback. Direct function-call restrictions depend
  on XF integration; `writeSql.test.ts` retains the named regression todo until then. User-defined
  wrappers remain a database-role boundary.
- As with reads, a large individual cell reaches the driver before clipping. The bounded card
  is not a claim that driver memory is bounded for arbitrarily wide rows.

```sh
POLARIS_TEST_PG_URL='<disposable Postgres 16 URL>' \
POLARIS_TEST_MYSQL_URL='<disposable MySQL 8.4 URL>' \
POLARIS_DATA_WRITE_TRACE_DIR=/private/tmp/polaris-w-traces \
bun test apps/daemon/src/data/writeExecution.real.test.ts apps/daemon/src/data/writes.real.test.ts
bun packages/spec/scripts/replay-data-write.ts /private/tmp/polaris-w-traces/postgres.json
bun packages/spec/scripts/replay-data-write.ts /private/tmp/polaris-w-traces/mysql.json
```

## Schema Diff (ENG-645)

`SchemaSnapshots.get({sessionId, turn?})` is the internal Review accessor;
`data.schemaDiff` and the Client/IPC `getDataSchemaDiff` expose the same result.
The separate `data.schemaDiff` capability keeps older Data Daemons out of this RPC.
Omitting `turn` compares the first captured baseline with the last end catalog for
each source in the session. Changed targets never form a cross-database diff.

The scoped worker subscribes after committed Turn events and Query Log activity.
It does no catalog I/O in decide, acknowledgement or query execution. Describe
publishes first-use activity too; outside commands use matching running item
progress and the completed Query Log entry. Catalogs are metadata only, capped at
500 tables and a 30-second snapshot deadline. A single consumer serializes catalog
work, including sessions sharing a checkout; adjacent starts coalesce until Data
activity. No periodic timer or idle watcher is added. Source discovery only runs on Turn
boundaries or Data activity, and a checkout without Data never opens a SQL pool.

A migration-capable checkout has discovered sources and a known migration path:
`prisma/migrations`, `drizzle`, `db/migrate`, `*/migrations`, `supabase/migrations`.
Only Local sources get candidate Turn-start baselines. A previous Turn's end is
reused when its target is unchanged, no other session has since used the checkout's
Data, and another session is not currently working there. Reused baselines carry
`previous-turn-end`, because outside changes between Turns may be included.
Candidates stay out of Review unless the Turn used the source or its checkpoint
diff changed a migration. Remote sources join only on first use with an existing
approval. The snapshot path never calls the approval-opening service.

`complete`, `pending` and `unavailable` distinguish a ready comparison from a
missing baseline/end or a failed capture. A bounded/incomplete catalog sets
`truncated`; unmatched objects then cannot establish additions or removals.
Renames require a unique same-schema match of the old columns in the new table.
Column, index and constraint changes preserve both sides. Row cards use completed
Query Log `affected` entries from this session's agent writes and user
`data.edits.commit` writes, with separate `agent` and `user` counts. Otherwise they
carry an explicitly labelled row-estimate delta (or unknown); reads, dry runs and
other sessions' writes never become exact counts. Exact counts persist with each
Turn, independently of Query Log retention. Catalogs persist in `data.sqlite`
and are deleted on session archive and Workspace removal; late captures cannot
resurrect removed records. Restart also removes orphaned catalogs.

Native acceptance uses disposable Postgres 16 and MySQL 8.4 databases:

```sh
POLARIS_TEST_PG_URL='<disposable Postgres URL>' \
POLARIS_TEST_MYSQL_URL='<disposable MySQL URL>' \
bun test apps/daemon/src/data/schemaSnapshots.real.test.ts
bun run bench idle --runs 3 --compare packages/bench/baselines/mac14-13-apple-m2-max-12c.json
```

The native fixture writes an actual migration file between git checkpoints,
adds a column and index, renames a table, and reads the stored per-Turn comparison.
Unit tests establish policy/persistence/lifecycle behavior; they do not establish
native database or idle-performance acceptance.
