# Managed language catalog evidence

K1 pins on-demand external tools without adding production dependencies or
installing developer runtimes. The catalog is in
`apps/daemon/src/languages/catalog/`. Nothing here installs into a Workspace,
changes a real user home, or wires the catalog into a running Daemon.

## Runtime upstream downloads (owner 2026-10-08)

ADR-0022 distinguishes runtime upstream downloads from tools bundled inside the
Polaris installer. `distribution: runtime-upstream` requires a recorded permissive
top-level license, pinned archive SHA256, and release LICENSE/notices retained beside
the install. Full compiler/runtime/vendor closure remains required for installer
bundles; it is no longer the activation gate for runtime downloads. Ruff 0.16.10
and basedpyright 1.40.2 use scoped `runtime-review-records.json` and
`runtime-download-policy.json`; these replace older review records for those pins.
The original closure inventories remain historical evidence. Missing distribution
metadata retains the original rules. No project interpreter is installed.

## Checks and release gate

```sh
bun test apps/daemon/src/languages/catalog tooling/language-catalog
bun tooling/language-catalog/check.ts
bun tooling/language-catalog/check.ts --release
bun tooling/language-catalog/audit.ts
```

The Python scripts need Python 3.11 or newer (`hashlib.file_digest`); macOS's
`/usr/bin/python3` is 3.9. `bounded-build.slow.test.ts` uses the first of
`POLARIS_PYTHON`, `python3`, `python3.15`…`python3.11` that is 3.11+, and skips
with a warning when none is (under `CI` it fails instead).

`check.ts` validates immutable evidence roots, catalog/lock identities, retained
notice bytes, and honest eligibility flags. It succeeds with explicitly blocked
entries. `--release` refuses pending **offered** artifacts. `audit.ts` independently
checks the offered complete npm closure against the existing general license policy.
Both strict release commands currently fail: see `docs/reports/m31/K1.md` and
`external-audits.json`. A consistency pass is not catalog release certification.
K2 owns remaining notice/source/policy closure before G1. The Lead owns central
release/license wiring. Legacy SQL is evaluation-only; its frozen evidence is
retained outside release gates. Active provider/formatter/companion references
cannot point at unknown or evaluation-only tools.

Each npm bundle contains the complete original private fixture manifest and
npm v3 lock, plus verified SHA512 package roots and legal-file hashes, including
optional/off-platform dependencies. `audit.ts` decodes a projection for auditing;
**do not round-trip its decoded `Bundle.lock` as an install lock**. Forward the
original immutable raw lock from the pinned bundle, as `prepare.py` does.

`audits/<artifact-id>.json` binds the artifact root, bundle/evidence roots and
notice requirements. Its SHA256 is pinned in the catalog. Notice requirements
are decoded from these immutable roots, never from installer assertions.
`notices/<sha256>.txt` retains upstream legal text verbatim. Supplemental notices
include immutable upstream source references; absent notices remain findings.

## Opt-in reproducible fixtures

This uses public registries and creates only a new temporary evaluation root:

```sh
python3 tooling/language-catalog/prepare.py --root /tmp/k1-fixture \
  --tool typescript-language-server --tool actions-language-server \
  --tool bash-language-server --tool sqllens-language-server \
  --tool sql-language-server --tool sql-formatter
python3 tooling/language-catalog/smoke.py --root /tmp/k1-fixture \
  --output /tmp/k1-fixture/smoke.json
node /tmp/k1-fixture/npm/sql-formatter/node_modules/sql-formatter/bin/sql-formatter-cli.cjs \
  --language postgresql <<'SQL'
select 1::integer;
SQL
```

`prepare.py` requires a new root below canonical `/tmp` (`/private/tmp` on macOS),
verifies audit/bundle roots and effective npm configuration before bounded
`npm ci --ignore-scripts`, with explicit temporary cache/prefix/user/global
config paths. It inherits PATH only; HOME and credentials/settings inheritance
are absent. Evaluation of a
blocked artifact in a disposable fixture does not authorize activation.
`smoke.py` reaps detached groups with bounded TERM/KILL on success/failure/timeout and asserts actual completion, SQL dialect
syntax differences, static-schema typed hover and Actions diagnostics. No
GitHub token, connection credentials, database, SSH Host or real project is used.

The legacy SQL probe requires the recorded protocol override. It is retained as
rejected-default evidence. The sqllens probes disable plugins with
`SQLLENS_NO_PLUGINS=1` and an explicit temporary `SQLLENS_USER_CONFIG`. PostgreSQL/MySQL document IDs test dialect behavior without
a required checked-in Polaris configuration file.

## Capturing audits for an explicit catalog update

Never resolve `latest` at install time. Existing release snapshots are immutable.
For a deliberately selected new release, use a new disposable root and review
its exact manifest/lock/metadata before capturing it:

```sh
python3 tooling/language-catalog/collect.py --root /tmp/k1-fixture \
  --output tooling/language-catalog
python3 tooling/language-catalog/collect-cargo.py --root /tmp/k1-catalog \
  --output tooling/language-catalog
python3 tooling/language-catalog/inspect-native.py --root /tmp/k1-catalog \
  --output tooling/language-catalog
bun tooling/language-catalog/assess.ts
bun tooling/language-catalog/check.ts
```

`collect.py` reads already-selected temporary npm locks, hashes entire tarballs,
and reads only package metadata and legal entries. `collect-cargo.py` reads
release-matched Cargo locks, verifies every registry crate against its checksum,
and reads only Cargo manifests and legal entries. `inspect-native.py` reads
already-downloaded pinned JDT/Lua/Phpactor fixture containers and inventories
only names, manifests, hashes and legal entries. Its output is evidence, not a
claim that a source lock exactly proves a binary's build closure.

`assess.ts` derives npm findings and immutable audit roots. It never grants an
external-license exception or marks incomplete native audits complete. Native
review work must improve the evidence and its explicit activation reason first.
Rerun the final checks after changing snapshots; formatting participates in
bundle/manifest hashes.

## Installer obligations

I1 must embed/transfer the exact frozen bundle and audit roots with the catalog;
these tooling files are not yet wired into a production Daemon build. Select an
exact OS/architecture/libc artifact, verify bytes before extracting, reject
traversal and escaping symlinks/hardlinks, retain every required notice, and
stage/activate privately. `safeArchivePath` is a path check, **not** an extractor
or a symlink policy. Verify every dependency tarball against its frozen root;
verification of the top npm tarball alone does not cover its dependencies.
Never execute npm install scripts by default or resolve a new dependency graph.

Go tools require the developer's Go: use private GOBIN/GOMODCACHE/GOCACHE,
`GOTOOLCHAIN=local`, the pinned complete module closure and checksum roots, and
no runtime download. Only a source-build installer that honors those rules can
activate gopls. JDT LS uses developer Java 21 and copied private configuration;
its launcher is not the convenience Python wrapper. Native notice/exception
blocks and G1 review requirements cannot be bypassed by successful startup.
