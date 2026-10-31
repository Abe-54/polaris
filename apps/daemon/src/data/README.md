# Checkout Data Sources (ENG-644)

`DataSources.layer` uses EventStore only to read `record.session.cwd`, HostSecrets to keep
manual-source passwords, and `DataSourceAccess` to attach approval state. Sessions in the same
checkout share stable ids (SHA-256 of the real checkout path + NUL + name), manual sources and labels.
The default access policy reads local sources and leaves remote sources needing approval; X
replaces it. It is independent of the Engine so the Engine, MCP and RPCs share one instance.

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
`matchUrl` is for outside-command matching only, never for connecting. X must pass the explicit connection fields (with `adapter: source.engine`), never the URL, to
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
