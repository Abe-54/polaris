---
status: accepted
---

# Agents query Data Sources through the Daemon, never with credentials

## Context

Agents are bad at databases mostly because they are blind: they guess the schema, run ad-hoc
`psql` with a URL copied from `.env`, and misread the output. Data (⌘4, ENG-643) gives them a way
to see the data, and gives the user a record of what they ran. That means deciding where Queries
run, what an agent is handed, and what stops it from writing where it shouldn't.

Constraints already in place: Polaris never touches provider credentials (ADR 0001), repository
code gets an allowlisted environment (ADR 0054), and a secret never enters the event log
(ADR 0089). The Daemon runs on Bun ≥ 1.3.9, whose `Bun.SQL` has native `postgres` and `mysql`
adapters (checked on 1.4.4).

## Decision

**Every Query runs in the Daemon, on the Host, against a Data Source the agent names; the agent
never sees a URL or a password, and the database itself enforces read-only.**

- **Execution.** The Daemon opens connections with `Bun.SQL`; the Desktop App and Mobile App only
  send Queries and receive rows. No driver, pool or credential lives in a Client.
- **Naming.** Data Sources are discovered per checkout (`.env*` files, framework config, compose
  services) or added by the user. Agents call `data_sources`, `describe`, `query` and `execute`
  (Polaris MCP tools on every binding) with a Data Source's name. Discovered URLs are re-read from
  the checkout on each connect and never persisted; a manual Data Source's password lives in
  Secure Storage (ADR 0044).
- **Read-only by the database.** `query` runs inside `SET TRANSACTION READ ONLY` (Postgres) or
  `START TRANSACTION READ ONLY` (MySQL), with a 30 s statement timeout and results capped at
  200 rows / 16k characters. We do not classify SQL by parsing it: functions, CTEs and vendor
  syntax make a parser an incomplete guard, while the server's read-only transaction is not.
- **MySQL's DDL escape.** MySQL commits implicitly before DDL, so `CREATE TABLE` succeeds inside
  `START TRANSACTION READ ONLY` (seen on 8.4.13, ENG-644 spike). On MySQL only, `query` also
  takes a single statement whose first keyword is SELECT, WITH, TABLE, VALUES, SHOW, DESCRIBE or
  EXPLAIN, and refuses `INTO OUTFILE`/`DUMPFILE`. This allowlist is a second guard, not the
  first; a SELECT-only database user per Data Source is the recommended hardening (later).
- **Local and Remote.** A Local Data Source is readable by agents without asking. Loopback and
  Unix sockets require a known database-server listener owner; a Docker/OrbStack proxy also requires
  a running compose database published from this real checkout. Resolve-time owner probes fail
  closed, so tunnels and unknown owners are Remote. A Remote one needs a Data Source Approval: per
  Host, for its exact server, database and user (or the whole server); a target that changes needs
  a new one.
- **Writes.** `execute` always asks the user. Before asking, the Daemon runs the statement in a
  transaction and rolls it back, so the approval shows the affected count and before/after rows.
  Approved, it runs again for real. On a Remote Data Source the user must also have allowed writes.
- **Record.** Every Query, the user's and the agents', goes into the Query Log with its Agent
  Session and Turn. `psql` and `mysql` Tool Calls are matched and logged as "outside Polaris": we
  can't stop an agent with a shell from connecting itself, but we can make it visible.

## Consequences

- An agent that reads `.env` itself can still connect directly; the Query Log marks it and the
  tools make the direct route unnecessary, but this is not a sandbox.
- A dry run executes the write's reads and locks once more; long-running or side-effecting
  statements (sequences, triggers that call out) are visible in the approval, not prevented.
- Adding a database engine means a `Bun.SQL` adapter and its read-only transaction statement;
  SQLite (ENG-646) is next.

## Guard matrix after RX (ENG-644)

A SELECT-only database user is the recommended connection. Read-only transactions prevent writes
on that connection; they do not prevent privileged functions, external connections or server
administration. The connection card reports observed superuser, `pg_signal_backend`,
`pg_read_server_files`, EXECUTE on dblink, MySQL SUPER and FILE privileges after connecting.
An unavailable privilege check is shown explicitly. These warnings do not grant access.

| Boundary | Postgres | MySQL |
| --- | --- | --- |
| One statement | Lexer handles quotes, dollar strings, nested comments; refuses Unicode-escaped identifiers | Lexer uses observed `sql_mode`; rejects executable comments and hints |
| Read transaction | `BEGIN READ ONLY`, local statement deadline | `START TRANSACTION READ ONLY`, server execution deadline plus targeted KILL |
| Functions | Deny external/admin/file/large-object/advisory/session functions, `*_to_xml` and `pg_sleep_*`; ordinary `pg_sleep` stays deadline-bound, `pg_backend_pid` stays available | Deny GET_LOCK, RELEASE_*LOCK(S), IS_*_LOCK BENCHMARK, SLEEP and user-variable assignments (`:=`); refuse names in `mysql.func` |
| Catalog check | Same reservation resolves called names in `pg_proc`; reject dblink/postgres_fdw/adminpack extension members and superuser-owned SECURITY DEFINER functions | UDF catalog visibility is required for statements containing function calls; lookup errors fail closed |
| Shared locking reads | Server refuses them | Lexer refuses FOR SHARE and LOCK IN SHARE MODE, including comment-separated keywords |
| Receive budget | Metadata-only FETCH, then server projection and 16-row FETCH batches | Metadata-only LIMIT 0, then server projection and cumulative byte limit |
| Pool release | Advisory unlock-all and RESET ALL outside the transaction; close on failure | Close the reservation, clearing locks, user variables and other session state |

The result projection retains the original column types, clips cells on the server (at most
32 KiB per cell, reduced for wide rows), and returns a 128-character Truncated preview with the
original text byte count. A 1 MiB receive budget includes metadata allowances. Results report
`truncated` when any cell, row or column limit is hit. This is deliberately below the 1 MiB cell
ceiling and the 64 MiB Daemon RSS budget. Server work remains bounded by the Query deadline;
projection cannot bound the database server's own memory. Custom operators, casts, invoker
functions and database triggers are reasons to use restricted credentials, not a substitute for
them. The function guard also applies to execute; write approval does not authorize external
side effects.

The deadline starts before waiting for a pooled connection. PostgreSQL error positions subtract
the cursor prefix; MySQL syntax errors remove the wrapper and report the user's SQL line.
Query Log retention is per Host: 30 days, 10,000 entries and 16 MiB of serialized entries, oldest
first. Age pruning runs on writes and reads, with no idle timer.

Source rules distinguish decisions from defaults. A Local default is recomputed on every
require and never grants Remote access. Writes-policy changes do not create read grants.
Remembered server scope is engine, host, port and user. Revoke removes all exact/server rules
covering the target and restores the Local default when applicable. Pending approvals share one
card per target across sessions. `remember:false` authorizes only the joined query/describe
request, consumed once for its session and active Turn; it never authorizes a write dry run.
Remote execute still requires remembered read approval, writes enabled and a separate approval
for each statement.
