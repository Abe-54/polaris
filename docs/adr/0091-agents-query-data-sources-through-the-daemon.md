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
- A dry run protects transactional rows, not every side effect. Sequence allocation (`nextval`
  and auto-increment) can survive rollback, as can independent transactions or external calls
  hidden in user functions/triggers. MySQL row writes therefore require InnoDB, and MySQL DDL
  is refused because it commits implicitly. Local Postgres transactional DDL is supported;
  remote DDL is refused. Direct dblink, signal and lock functions use the shared guard;
  restricted database roles remain the boundary for wrappers. PostgreSQL NOTIFY is transactional
  and is not delivered on rollback ([PostgreSQL 16 documentation](https://www.postgresql.org/docs/16/sql-notify.html)).
- Remote execute requires remembered read access and writes allowed, plus one per-statement
  write approval. A one-request read grant does not authorize a dry run. Consumed write authority
  is never replayed automatically after an uncertain external commit; this prevents duplicate
  dispatch but cannot make SQLite and an external database one atomic transaction.
- Adding a database engine means a `Bun.SQL` adapter and its read-only transaction statement;
  SQLite (ENG-646) is next.
