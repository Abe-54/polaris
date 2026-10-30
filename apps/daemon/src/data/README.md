# Checkout Data Sources (ENG-644)

`DataSources.layer` uses EventStore only to read `record.session.cwd`, HostSecrets to keep
manual-source passwords, and `DataSourceAccess` to attach approval state. Sessions in the same
checkout share stable ids (SHA-256 of checkout + NUL + name), manual sources and labels.
The default access policy reads local sources and leaves remote sources needing approval; X
replaces it. It is independent of the Engine so the Engine, MCP and RPCs share one instance.

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
X must pass the explicit connection fields (with `adapter: source.engine`), never the URL, to
Bun.SQL: Bun 1.4.4's URL constructor lets PGDATABASE change an explicit URL's database.
Postgres query parameters host/port/user/dbname/password override authority fields; socket/path
and TLS modes are resolved explicitly. Ambiguous repeated target parameters are skipped.

`data.sqlite` stores manual metadata and labels in separate tables, not in the event log. Its
mode is 0600. Passwords live only under `data/<id>` in HostSecrets, base64-encoded at this
namespace boundary so spaces, quotes and Unicode pass the existing token validator. Other
secret namespaces retain their validation. The empty password uses `=` as its encoded token.
Errors report constant text and never include parser, SQLite or Secure Storage error details.
