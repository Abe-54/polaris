# Data tools v1: the agent's contract

Polaris MCP tools for Data (ENG-643; ADR 0091; glossary in CONTEXT.md → Data). On every binding
(Claude, Codex, reviewers) beside the other session tools in `apps/daemon/src/mcp/tools/`. The
Daemon resolves the caller's Agent Session, its checkout and current Turn from the binding; no tool
takes a session, path or URL. Phase 1 (ENG-644) ships `data_sources`, `describe` and `query`;
phase 2 (ENG-645) adds `execute`.

## Shared rules

- **Names, never credentials.** A Data Source is named as `data_sources` lists it (e.g. `app`,
  `analytics`). No output ever contains a URL, user password, token or connection string; a
  host:port and database name may appear.
- **Output is text first.** One text block an agent can read without parsing, capped at 16,000
  characters, plus `structuredContent` with the same data as JSON. Truncation always says what was
  dropped and how to get it ("200 of 18,402 rows; add a WHERE or an aggregate").
- **Values.** `NULL` for null; strings longer than 200 characters clipped with `…(+n chars)`;
  binary as `<bytes n>`; JSON compact on one line; timestamps ISO 8601 with offset; numerics as the
  database returned them (no float conversion).
- **Logged.** Every call that touches a database (`describe` with samples, `query`, `execute`, and
  the dry run) is a Query in the Query Log with the session, Turn and tool. `data_sources` and
  schema reads from cache are not.
- **Errors** set `isError: true` with `{code, message, fix}` like the other Polaris tools:

| Code | When | Fix text (gist) |
|---|---|---|
| `E-DATA-UNKNOWN-SOURCE` | no Data Source by that name in this checkout | call `data_sources` |
| `E-DATA-UNREACHABLE` | connect failed (refused, DNS, auth) | the reason; "the user can check it in Data (⌘4)" |
| `E-DATA-DENIED` | the user denied this Remote Data Source | don't retry; ask the user |
| `E-DATA-READ-ONLY` | the database refused a write, or the MySQL query allowlist refused a statement | use `execute` (phase 2), which asks the user |
| `E-DATA-TIMEOUT` | the 30 s statement timeout fired | narrow the query |
| `E-DATA-SQL` | any other database error | the scrubbed database message and position |
| `E-DATA-CANCELLED` | an explicitly cancelled Query recorded in the Query Log | run it again if needed |

- **Remote Data Sources.** A read of a Remote Data Source without a Data Source Approval opens one
  as a needs-you approval in the caller's conversation (the card in DESIGN.md → Data → Approvals)
  and the call waits on it, like any approval: approved, it runs; denied, `E-DATA-DENIED`. It goes
  through the Agent Session machine and the approvals in `packages/spec`, never around them.
  Approvals are remembered per Host (exact server, database and user, or the whole server).

## `data_sources {}`

Lists the Data Sources of the caller's checkout, discovered fresh. `reachable` is absent until
connection has been tried; false means unreachable and true means reachable. Loopback addresses
and Unix sockets require a database-server owner or a verified compose database proxy from this
checkout to count as local; tunnels and unknown owners need approval.

```
3 data sources in ~/code/ledger.worktrees/overdue-totals
app        postgres 16.4  local   localhost:5432/ledger_overdue   from .env.local (DATABASE_URL)   read · writes ask you
analytics  mysql 8.4      remote  db.internal:3306/analytics      added by you                     needs approval
branch     postgres 16    remote  (PlanetScale branch overdue-totals)  from .env (DIRECT_URL)    approved · read only
```

`structuredContent`: `{ sources: [{ name, engine, version?, locality: "local"|"remote", branch?: {provider, name}, host, port, database, foundIn, access: "read"|"needs-approval"|"denied"|"approved", writes: "ask"|"off", reachable?: boolean, error? }] }`.

## `describe {source, table?, sample?}`

- Without `table`: schemas → tables with row estimates, column counts and `columns: [{name, type}]`, views, and function
  names; at most 500 tables, then a count of the rest.
- With `table` (`schema.table` or a bare name resolved through the search path): columns (name,
  type, nullable, default, primary key, foreign key target), indexes, check and unique constraints,
  the row estimate, and, with `sample` (0–20, default 0), that many rows read through `query`'s
  read-only path (logged).

```
public.invoices  ~18,402 rows
  id            uuid          not null  pk  default gen_random_uuid()
  customer_id   uuid          not null  → public.customers.id
  total_cents   bigint        not null
  due_at        timestamptz   null
indexes: invoices_pkey (id), invoices_due_at_idx (due_at)
```

## `query {source, sql, params?, limit?}`

One statement (multiple statements are `E-DATA-SQL`), run in a read-only transaction (`SET
TRANSACTION READ ONLY` / `START TRANSACTION READ ONLY`) with a 30 s statement timeout. `params`
binds `$1…` (Postgres) or `?` (MySQL). `limit` ≤ 200 (default 200) caps rows returned, not rows
scanned. Output: a header line (`12 rows · 34 ms · query q_7f3a`), then the rows as an aligned
text table with column names and types in the header; past 16k characters rows are dropped from
the end with the count said. `structuredContent`: `{ queryId, columns: [{name, type}], rows: DataValue[][], rowCount, returned, total?, truncated, elapsedMs }`.

## `execute {source, sql, params?, reason}` (phase 2)

A write. The Daemon first runs it in a transaction and rolls back (the dry run, logged), then opens
a needs-you approval in the conversation showing the SQL, `reason`, the affected count and up to
20 before/after rows. Approved, it runs for real and returns `{ queryId, affected, elapsedMs }`;
denied, `E-DATA-DENIED` with the user's reason ("Deny and tell the agent why"). A Remote Data
Source also needs writes allowed on it, else `E-DATA-DENIED` without asking.

## Outside Polaris

A shell Tool Call that runs `psql`, `mysql`, `pg_dump` or a driver one-liner against a URL from the
checkout is recorded in the Query Log as "outside Polaris" (matched on the command, never blocked).


## Wire values and credential scrubbing (RC F1/F2/F6)

`DataValue` is null, boolean, string, a finite number, or one of these tagged objects:

| `_tag` | Fields | Rendering |
| --- | --- | --- |
| `Bytes` | `length`, `preview?` (base64) | `<bytes n>` |
| `BigInt` | `value` (decimal string) | exact value |
| `Numeric` | `value` (database text) | exact value, including precision/scale |
| `Json` | `text` (compact JSON) | one line |
| `Timestamp` | `iso` (ISO 8601 with offset) | ISO timestamp |
| `Truncated` | `preview`, `bytes` (original encoded size) | preview plus an explicit truncation marker |

Drivers normalise `Date`, bigint and binary before constructing results; raw driver objects,
NaN and Infinity are rejected. Parameters use the same wire type, converted back by the executor;
query inputs are never scrubbed before binding. Outputs and logged params are scrubbed. Each cell
is at most 65,536 bytes as JSON in UTF-8, including JSON escaping and tagged fields. The executor
replaces oversized cells with `Truncated` and a bounded preview before encoding. Rows have at most
256 columns. Unary results contain at most 200 rows and 4 MiB of encoded rows; producers drop tail
rows to meet that budget, setting `truncated`. `rowCount` is the legacy alias of `returned`.
`total?` is present only when known, never inferred from the returned window or a costly extra count.
`SchemaTree.loadedAt` is the time the catalog was loaded, including when returned from cache.

`@polaris/protocol` exports `scrubCredentials(text, known?)` and `scrubDataValue(value, known?)`.
`known` is `ReadonlyArray<Redacted<string>>`: the resolver's decoded password and full URL plus
URL-decoded and percent-encoded forms of each. Exact values of at least four characters are
replaced with `[redacted]`, longest first, regardless of the column name. URL userinfo and
`password=`, `PGPASSWORD=`, `MYSQL_PWD=`, `passwd=` and `pwd=` assignments (including quoted DSNs)
are scrubbed too. Short known values do not mask unrelated text. Producers must apply the known
set before logging or emitting results/errors. Wire transforms additionally scrub free-text
errors, fixes, SQL, commands and logged parameter values on both decode and encode. `DataHost`
accepts hostnames, IP addresses or socket paths and refuses URLs/userinfo. A source's identity
fields must come from the parsed target, never the raw connection string.

## Desktop stream, cancellation and capability (RC F3–F8/F12)

`data.query` stays agent-sized. Client-only `data.query.stream` takes the same payload with
`limit` from 1 to 10,000 (default 10,000). Its stream emits, in order:

1. `{_tag: "Header", queryId, columns: [{name, type}]}` before row work.
2. `{_tag: "Rows", rows: DataValue[][]}` chunks, at most 500 rows and 1 MiB of JSON per chunk.
3. `{_tag: "End", returned, total?, truncated, elapsedMs}` once work completes.

The RPC handler rechunks to one item per RPC frame, so Effect cannot batch bounded items into an
oversized frame. All stream items, including the header, are capped at 1 MiB before RPC framing. Producers split
chunks by encoded bytes as well as rows. A single overly wide row must be clipped with cell
markers to fit a chunk. Consumers must not assume a full 500 rows in each chunk. The stream owns
the executor scope and read-only transaction: renderer unsubscribe, window close, connection loss
or interruption cancels server work and rolls back/releases it. Interruption is the live wire
signal (no terminal chunk is promised after unsubscribe); `E-DATA-CANCELLED` names the retained
Query Log outcome. SQL errors use the typed stream error. IPC preserves `{code,message,fix,position?,line?}`; `position` is a database-reported one-based
character offset in submitted SQL, `line` a one-based line number, both omitted when unknown (the protocol names the latter `DataError.sqlLine` to avoid
Bun Error’s unrelated stack `line` field);
Unsupported gives an upgrade explanation rather than an empty message.

The Daemon advertises `data` only when its real discovery, Query, Query Log and approval Layers
are composed. Stubs never advertise it. A new Client checks `supportsData` before opening a Data
surface. On older Daemons the source/log watch helpers end empty without emitting a snapshot;
unary requests and the Query stream fail with Unsupported. Do not wait for a first watch value
without checking the capability. A new Daemon remains compatible with old Clients that never
send these additive methods.

## Query Log and source management (RC F5/F9–F11)

`QueryLogEntry.state` is `running | waiting-approval | completed | failed | dry-run | cancelled`.
`params?` contains scrubbed `DataValue[]` in bind order; a redacted value must be supplied again
before a faithful rerun. `approval?: {id, status: pending | approved | denied}` links a waiting row
to its real ApprovalRequest. Source and Query errors use `DataError`, including
`E-DATA-UNKNOWN-SOURCE`, rather than `NotFound`.

`data.queryLog.watch` emits whole snapshots of the newest 100 entries, newest first, replacing
the previous window on each change; it is not the full retained log. `data.queryLog.page` takes
`{sessionId, before?, limit?}` (1–100, default 100), returning `{entries, next: string|null}`.
`before` is the exclusive stable entry ID returned as `next`, so equal timestamps do not skip or
duplicate entries; null means no older page. Retention and storage are the Query Log service's job.

`data.source.save` adds `previousName?` for editing/renaming a manual source in one operation.
`passwordAction?: keep | clear | set` distinguishes retaining Secure Storage from clearing it;
`set` requires `password` (write-only Redacted on the wire), and `keep`/`clear` reject a supplied
password. Without an action, an omitted password means keep and a supplied password means set,
preserving existing callers. Renaming moves the retained password with the manual source.
`data.source.access {sessionId,source,writes?: ask|off,revoke?:boolean}` updates write policy and/or
revokes remembered access for that target; it returns the current safe DataSource.

Data Source Approvals are decided only by `RespondToApproval {sessionId,requestId,decision}`.
`ApprovalDecision.Allow` has optional `dataScope: target | server`; omission means target, never
server. The request's `DataSourceApproval` metadata names the exact safe target (X's contract).
The normal approve grants for Extensions and Linked Devices still apply. There is no
`data.approval.decide` RPC. The existing Agent Session approval machine and interruption model
remain authoritative; adding metadata and a Client stream does not introduce another event log.
