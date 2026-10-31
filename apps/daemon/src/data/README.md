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

`DataQueries.execute` always needs one user approval, independent of the Agent Session's
permission mode. Writes off refuses both execute and grid commits before a preview or card,
on Local and Remote sources. Remote writes additionally require remembered read access.
Write policy is stored with its locality; revocation restores defaults without saving a rule.
A Local default or explicit Local write grant never enables a Remote target.

Before a preview, the Daemon checks the statement's functions and the target's metadata under
locks. Non-built-in functions, dblink and privileged functions are refused; PostgreSQL defaults,
constraints, policies, rules and expression indexes cannot call user functions either. A table
with triggers is **not previewed**. Its card says "Not previewed: this table has triggers", shows
SQL and scrubbed parameters, and offers "Run without preview". MySQL checks the tables reached
through trigger chains too: every inspected table must use InnoDB and stay in the approved
database. Routine calls and uninspectable dependencies fail closed (at most 100 tables).

A safe preview runs in a writable transaction and rolls back before opening a card through the
Session machine. The card shows scrubbed parameters and up to 20 before/after rows in a 16,000
byte budget. INSERT has an empty before image and its inserted rows in after. Credential column
names (password, passwd, secret, token, api_key, private_key, credential and their compound forms)
are redacted before persistence; all other cells use the shared scrubber. Only the capped display
rows enter the durable event. Original values are used internally to bind keys and hash identity.
Sequence values used by the preview aren't reused: serial, identity and AUTO_INCREMENT allocation
can advance even though the transactional rows roll back.

A real run must match the preview's count **and complete identity hash** before COMMIT, or the
transaction rolls back. UPDATE/DELETE hash primary-key tuples, or full row images without a key.
INSERT hashes inserted row images, excluding columns omitted from the explicit column list that
the database fills itself (including identity/serial/AUTO_INCREMENT and volatile defaults).
Explicit keys and values stay in the hash. INSERT rows are identified by a before/after multiset;
the current implementation requires the complete table snapshot to fit the identity budget.
Identity reads are bounded at 10,000 rows and the existing server byte/column limits; any omitted
or clipped identity fails closed. This limit applies independently of the 20-row display cap.

An explicit requestId binds a retry to its Agent Session and durable argument hash. Without one,
the fingerprint binds the Session, Turn, source, target, SQL, parameters and reason. Changed
arguments cannot reuse a key. Completed receipts are returned without reopening the source,
even after Turn end. A durable compare-and-set consumes approved authority once. Locks are per
target and removed when idle; a slow target does not queue all writes on the Daemon.

Cancellation before COMMIT rolls back and reports E-DATA-CANCELLED. Once COMMIT is sent, its
confirmation gets a non-cancellable five-second grace period. A confirmed result stays successful
even if the Turn ends. A lost connection or grace timeout reports E-DATA-OUTCOME-UNKNOWN and a
Query Log state of unknown: **check the rows before retrying**. Recovery marks unfinished writes
unknown. Failed, started and unknown requests cannot dispatch again. This is at-most-once dispatch,
not an atomic commit spanning the database and data.sqlite. Pending cards are denied on Turn end
or recovery; a denial without a reason says "The user denied this write."

`data.edits.commit` groups cells by typed key equality, checks the actual database row identities
to reject coercion duplicates, and requires one matched row per update (including MySQL no-ops).
The whole batch rolls back on a mismatch. Bytes keys carry a complete base64 payload and bind as
bytes on both engines; display-only, clipped or unsupported keys are refused with a reason.
The Query Log attributes the batch to the user and completed writes name their affected tables.
Clients negotiate `data.writes`; the Desktop App owns the Remote bulk confirmation.

### Write limits (ENG-669)

- INSERT, UPDATE and DELETE name one explicit table. Read-only subqueries and INSERT … SELECT
  are supported; joins, aliases, CTEs, RETURNING, ORDER/LIMIT and tuple assignments are refused.
- Upserts (ON CONFLICT and ON DUPLICATE KEY UPDATE) are refused. Primary-key assignments are
  checked across the entire statement, case-insensitively on MySQL, before any write executes.
- Every Local Postgres DDL statement (including TRUNCATE) requires "Run without preview";
  the card says "Not previewed: this statement changes the schema" and shows exact SQL and
  scrubbed parameters. MySQL implicit-commit DDL and Remote DDL are refused.
- A changed trigger definition after preview requires a new approval without preview. Database
  roles still limit what an **approved** trigger can do; no unapproved trigger is executed.
- Explicit DEFAULT in an INSERT value list is refused when database-filled columns cannot be
  distinguished; omit those columns instead. Complete identity must fit the budget above.

### Write verification

RW regression tests are `writeFixes`, `writeRemote`, `writeRecovery`, `writeSafety.real`,
`writeIdentity.real` and `writeReplay.real`, alongside the original write suites. The native replay
records actual ApprovalRequested/Resolved events, WriteApprovalStore statuses, Query Log entries
and database observations. Version 2 rejects test-authored phase labels. It covers normal retries,
denial, same-count identity drift, not-previewed triggers and unknown COMMIT outcomes.

```sh
POLARIS_TEST_PG_URL='<disposable Postgres 16 URL>' \
POLARIS_TEST_MYSQL_URL='<disposable MySQL 8.4 URL>' \
POLARIS_DATA_WRITE_TRACE_DIR=/private/tmp/polaris-w-traces \
bun test apps/daemon/src/data
bun packages/spec/scripts/replay-data-write.ts /private/tmp/polaris-w-traces/*.json
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

Result column metadata currently comes from a zero-row probe before the bounded projection.
MySQL may evaluate constant expressions while optimizing that probe, so it is not an independent
side-effect boundary: it runs after the function/UDF guard in the same read-only transaction,
on the same reservation, under the same total deadline. SLEEP, BENCHMARK, lock functions and
user-variable assignments are refused before probing; session release clears any remaining user
variables. Use SELECT-only credentials (ADR 0091's guard matrix). ENG-670 tracks a driver path
that obtains prepared-statement column metadata without executing a probe.
