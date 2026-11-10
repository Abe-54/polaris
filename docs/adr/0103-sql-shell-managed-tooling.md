---
status: accepted
implements: Editor language tooling v2 slice 7b
---

# Keep SQL offline and ShellCheck developer-owned

Owner decisions on 2026-10-08 retain ADR-0022's permissive runtime-download
policy. ShellCheck is a Host Prerequisite: Polaris never downloads it. Bounded
standard-location presence probes supply an absolute executable path to managed
bash-language-server. Missing ShellCheck offers Homebrew/apt commands from the
catalog. Managed shfmt supplies formatting. Bash/POSIX scripts and shebangs are
supported; zsh and fish keep syntax highlighting without Bash analysis.

The owner authorized verification of an offline SQL alternative. Real pinned
sqllens 0.5.0 probes prove PostgreSQL, MySQL and SQLite completion and syntax
diagnostics without databases. Its generic language ID silently falls back to
Databricks. The owner chose generic formatting only, requiring a dialect for
language features. sql-formatter 15.9.0 uses the selected dialect. A small private
adapter adds formatting to the upstream server and withholds generic documents
from its analyzers. No upstream source is copied or adapted. Plugins and user
configuration are disabled; the server receives a private configuration root.

Host revision-CAS selection persists file/Workspace overrides atomically, with
Worktree inheritance and Review Checkout isolation. Changes reuse the broker's
restart machine and Replaced handoff; document text remains unsaved. Reading
hints and Prisma datasource metadata needs no Trust. Project formatters retain
their existing Trust and selection gates.

Unbundled npm servers and sql-formatter need their published dependencies.
Polaris extracts frozen upstream npm archives into a private dependency tree,
verifying each checksum and retaining notices. It runs no npm resolver, install
script, package build or Workspace code. The frozen dependency inventory and
private SQL adapter bytes are bound into installer audit roots. Compiler/vendor
closure records remain historical; these are runtime downloads, not installer
bundles. ShellCheck's historical catalog artifacts remain blocked.

The Desktop retains a separate context per SQL file because dialects can differ
inside one project. Bash Language Server uses an exact INT_MAX whole-document
formatting sentinel; the Host replaces only that sentinel with the fenced
snapshot's UTF-16 end position. All other formatting ranges retain strict
validation, including malformed positions and Unicode boundaries.

Managed configuration replies and notifications use the private launch settings;
user server settings cannot redirect ShellCheck/shfmt, enable background scans
or enable explainshell. Configured custom servers retain their Trust boundary.
