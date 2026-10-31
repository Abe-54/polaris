# Checkout Data Sources (ENG-644)

`DataSources.layer` uses EventStore only to read `record.session.cwd`, HostSecrets to keep
manual-source passwords, and `DataSourceAccess` to attach approval state. Sessions in the same
checkout share stable ids (SHA-256 of checkout + NUL + name), manual sources and labels.
The access policy reads local sources and applies remembered approvals to remote sources. It is independent of the Engine so the Engine, MCP and RPCs share one instance.

`list` and `resolve` read configuration afresh; no polling, cache or extra file watcher is installed.
`watch` subscribes before reading its snapshot, then updates on manual-source and label mutations.
Filesystem edits are reflected on the next request or watch subscription. `reachable: false`
means discovery has not connected; it performs no network probe.

Discovery reads root `.env*` files, root/`prisma/schema.prisma`, root `drizzle.config.{ts,js,mjs}`,
Rails `config/database.yml` development, root or one-directory-deep Django `settings.py`, and the
four compose filenames. Environment precedence, lowest first: `.env`, other suffixes in sorted
order, `.env.development`, `.env.local`, `.env.development.local`. A key has one source; an env
reference from Prisma/Drizzle does not duplicate it. DATABASE_URL is named `app`; other keys
and compose services are lowercased. Manual sources shadow discovery by name.

Framework discovery reads literals only; it never imports or executes a checkout's code. Django
and Drizzle targets with dynamic fields are skipped. Rails supports YAML aliases and literal
`ENV["KEY"]` interpolation from checkout env files, but does not run ERB. Compose requires a
published database port and maps a matching container hostname to the Host's published port.

Discovered URLs exist only in memory. `resolve({sessionId, source})` accepts a name or stable id
and returns `{source, connection, url}` internally. The URL and connection password are Redacted.
Execution passes the explicit connection fields (with `adapter: source.engine`), never the URL, to
Bun.SQL: Bun 1.4.4's URL constructor lets PGDATABASE change an explicit URL's database.
Postgres query parameters host/port/user/dbname/password override authority fields; socket/path
and TLS modes are resolved explicitly. Ambiguous repeated target parameters are skipped.

`data.sqlite` stores manual metadata and labels in separate tables, not in the event log. Its
mode is 0600. Passwords live only under `data/<id>` in HostSecrets, base64-encoded at this
namespace boundary so spaces, quotes and Unicode pass the existing token validator. Other
secret namespaces retain their validation. The empty password uses `=` as its encoded token.
Errors report constant text and never include parser, SQLite or Secure Storage error details.

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
