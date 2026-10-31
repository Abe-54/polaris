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
- **Writes.** `execute` always asks the user. Eligible statements are previewed in a transaction
  that rolls back; tables with triggers require approval without a preview. The card shows SQL,
  parameters and any preview rows. Writes off applies to Local and Remote sources.
- **Record.** Every Query, the user's and the agents', goes into the Query Log with its Agent
  Session and Turn. `psql` and `mysql` Tool Calls are matched and logged as "outside Polaris": we
  can't stop an agent with a shell from connecting itself, but we can make it visible.

## Consequences

- An agent that reads `.env` itself can still connect directly; the Query Log marks it and the
  tools make the direct route unnecessary, but this is not a sandbox.
- Preview preflight refuses non-built-in functions and unsafe table expressions; triggers never
  run without approval. MySQL dependencies must all use InnoDB. Sequence allocation is the
  disclosed exception: sequence values used by the preview aren't reused. Restricted database
  roles remain necessary for effects of approved writes. See the RW fixes below.
- Remote execute requires remembered read access and writes allowed, plus one per-statement
  write approval. A one-request read grant does not authorize a dry run. Consumed write authority
  is never replayed automatically after an uncertain external commit; this prevents duplicate
  dispatch but cannot make SQLite and an external database one atomic transaction.
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


## RW write fixes (ENG-645)

Implementation and limits: [Data README, Writes](../../apps/daemon/src/data/README.md#writes-eng-645).

- F1: only side-effect-free statements get previews; triggers and all Local Postgres DDL require "Run without preview", and sequence values used by the preview aren't reused.
- F2: writes off refuses execute and grid commits on every source before inspection or approval.
- F3: COMMIT confirmation has a five-second cancellation shield; lost confirmation is E-DATA-OUTCOME-UNKNOWN and Query Log unknown.
- F4: approval payloads include scrubbed parameters; INSERT previews show inserted rows in after.
- F5: revocation removes rules; Local write policy never supplies Remote defaults.
- F6: complete key or row-image hashes bind drift independently of display caps; INSERT excludes database-filled columns and retains explicit values.
- F7: upserts join ENG-669's refused forms; primary-key assignments are checked over the statement and case-insensitively on MySQL.
- F8: MySQL statements and trigger dependencies stay within the approved database; PostgreSQL schema qualification remains allowed.
- F9: credential columns and shared-scrubber values are redacted before capped rows reach events or Clients.
- F10: the spec models preflight, not-previewed triggers, identity drift and unknown; replay checks recorded events, projection, Query Log and database observations.
- F11: grid grouping uses typed keys and actual matched identities to reject coercion duplicates.
- F12: complete Bytes keys bind as bytes; unsupported or display-only keys fail with a reason.
- F13: write semaphores are per target and retain no idle entries.
- F14: recovery marks running writes unknown; default denial names the write.
