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
| `E-DATA-READ-ONLY` | the database refused a write inside `query`'s read-only transaction | use `execute` (phase 2), which asks the user |
| `E-DATA-TIMEOUT` | the 30 s statement timeout fired | narrow the query |
| `E-DATA-SQL` | any other database error | the database's message and position, verbatim |

- **Remote Data Sources.** A read of a Remote Data Source without a Data Source Approval opens one
  as a needs-you approval in the caller's conversation (the card in DESIGN.md → Data → Approvals)
  and the call waits on it, like any approval: approved, it runs; denied, `E-DATA-DENIED`. It goes
  through the Agent Session machine and the approvals in `packages/spec`, never around them.
  Approvals are remembered per Host (exact server, database and user, or the whole server).

## `data_sources {}`

Lists the Data Sources of the caller's checkout, discovered fresh (cached ≤ 10 s).

```
3 data sources in ~/code/ledger.worktrees/overdue-totals
app        postgres 16.4  local   localhost:5432/ledger_overdue   from .env.local (DATABASE_URL)   read · writes ask you
analytics  mysql 8.4      remote  db.internal:3306/analytics      added by you                     needs approval
branch     postgres 16    remote  (PlanetScale branch overdue-totals)  from .env (DIRECT_URL)    approved · read only
```

`structuredContent`: `{ sources: [{ name, engine, version?, locality: "local"|"remote", branch?: {provider, name}, host, port, database, foundIn, access: "read"|"needs-approval"|"denied"|"approved", writes: "ask"|"off", reachable: boolean, error? }] }`.

## `describe {source, table?, sample?}`

- Without `table`: schemas → tables with row estimates and column counts, views, and function
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
the end with the count said. `structuredContent`: `{ queryId, columns: [{name, type}], rows: unknown[][], rowCount, truncated, elapsedMs }`.

## `execute {source, sql, params?, reason}` (phase 2)

A write. The Daemon first runs it in a transaction and rolls back (the dry run, logged), then opens
a needs-you approval in the conversation showing the SQL, `reason`, the affected count and up to
20 before/after rows. Approved, it runs for real and returns `{ queryId, affected, elapsedMs }`;
denied, `E-DATA-DENIED` with the user's reason ("Deny and tell the agent why"). A Remote Data
Source also needs writes allowed on it, else `E-DATA-DENIED` without asking.

## Outside Polaris

A shell Tool Call that runs `psql`, `mysql`, `pg_dump` or a driver one-liner against a URL from the
checkout is recorded in the Query Log as "outside Polaris" (matched on the command, never blocked).
