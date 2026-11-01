# P3 helper checkpoint — ENG-657

2026-10-31, on the assigned P3 branch, based on
`c4a1ce26f2a8820181b874b28166ee809b8fba6f`. This is the Lead's requested
implementation checkpoint before waiting for P1, not a completed Claim.

## Implemented

- `index.ts`: opt-in Node/Deno environment preparation, preserving existing
  NODE_OPTIONS, skipping an existing SDK unless overridden, and leaving known
  Bun launches untouched. Package discovery stays within the checkout and covers
  ancestor manifests for monorepos.
- `build.ts`, `embedded.ts`, `assets.ts`, `register.mjs`, `sdk.ts`: Node SDK and
  ESM loader bundling, shared import-in-the-middle registry, private
  content-addressed extraction, HTTP/fetch/pg/mysql2/express instrumentation,
  service name from the launch package, trace/log export and best-effort failure
  handling. The SDK never executes inside the Daemon.
- `detection.ts`: bounded, gitignore-aware fixed-exporter evidence gated on
  observed application work without arriving spans and an OTel dependency.
  Only file:line is returned. `fixedExporterChange` holds the research note's
  one-line endpoint fallback for P10.
- `scripts/build-daemon.ts`: build plugin embeds the Node assets when the
  instrumentation module is reachable. The Bun build API preserves compile
  targets, splitting, defines, native libraries and signing.
- Exact production dependency pins and generated third-party notices. No
  upstream source was copied or adapted into tracked source; the bundler
  consumes installed dependencies, so no ATTRIBUTION.md entry is needed.

## Checked

All evidence below is Reported: these commands have no Daemon command-item
references. No Verified receipt is invented.

The final validation ran sequentially inside the Host lease:
`bun apps/daemon/src/main.ts lease bench -- bun /private/tmp/p3-validate.ts`.
The temporary runner sets `GOMAXPROCS=2` for compiler concurrency and records
each command's exit independently. All five commands exited zero:

| Command | Result | Local log |
| --- | --- | --- |
| `bun test apps/daemon/src/traces/instrumentation` | 12 pass, 0 fail, 49 assertions | `/private/tmp/p3-checkpoint-focused.log` |
| `bun run typecheck` | 18/18 tasks pass, 13 cached, 37.804 seconds | `/private/tmp/p3-checkpoint-typecheck.log` |
| `bun run --cwd apps/daemon test` | 3,214 pass, 87 skip, 0 fail; 103,653 assertions across 570 files; 479.82 seconds | `/private/tmp/p3-checkpoint-daemon-tests.log` |
| `bun run lint` | Full format check and lint ratchet pass; 5,581 files | `/private/tmp/p3-checkpoint-lint.log` |
| `bun run licenses:check` | 1,278 production dependencies plus 132 installed platform builds; zero violations | `/private/tmp/p3-checkpoint-licenses.log` |

The real Node ESM HTTP app makes a fetch call and emits a correlated log. The
test reads server/client spans, the package service name and that log from the
real receiver and SQLite store. During implementation, concurrent log and trace
export produced a receiver 429 and zero stored traces; sharing one serial HTTP
Agent made the same test pass. Endpoint-down execution also exits successfully.

A later common-case fixture covers `headers: {...}` before a literal exporter
URL. The original flat-object matcher misses that URL; the corrected bounded
matcher includes nested options. Before committing, the same Host lease reruns
that regression without the fix (expected failure, source restored in finally),
then the full focused suite (13 tests), root typecheck and changed-file quality.
Those final-source results are recorded in `/private/tmp/p3-commit.log`; the
full Daemon and root-lint results above precede this isolated matcher correction.

The compiled-executable probe uses the same build plugin, materializes the
register from a fresh directory without checkout dependencies, and runs Node
with that extracted preload. The normal host Daemon build and native selftest
also passed (`/private/tmp/p3-build2.log`). The actual polaris runtime does not
reference these helpers until the post-P1 composition, so extraction through a
launch from the real polaris binary remains a final integration check.

Before edits, native `bench idle --quick --runs 3` against the committed Mac
baseline passed its gates (`/private/tmp/p3-idle-before.json`, `.log`). The Host
started with 8.2 cores busy; these are not quiet-Host timing measurements. No
baseline was changed. An after-integration idle run remains required.

Earlier sandbox socket tests could not bind loopback. Later unleased validation
hit a 20-second real-receiver timeout and a five-second bundle-setup timeout
while the operator reported load average 210 on 12 cores, 66 MB free memory and
12.7/14 GB swap used. Duplicate/stalled P3 compilers were stopped. The final
leased run passed without increasing any timeout. Root monorepo tests were not
run; the full Daemon suite covers this Area. Existing platform/live-service
skips remain skips.

Generated upstream licence texts intentionally retain their original CRLF
bytes (`THIRD_PARTY_NOTICES.md` is `-text` in .gitattributes); git diff's whitespace
warnings on those bytes are not hand-edited away.

## Remaining before a Claim

1. Wait for P1 acceptance and merge the integration head named by the Lead.
2. Compose the helper into P1's runtime injection after its Trust/ownership and
   endpoint checks; record skip reasons through TraceSettings.recordInstrumentation.
3. Integrate launch/no-spans evidence into read-triggered fixed-exporter discovery
   and record detection through the settings service. No idle polling.
4. Test a real child launched through that runtime path and check extraction from
   the actual built polaris binary. Repeat final checks and idle benchmark under
   the Host lease, commit, and submit the complete Claim.

P1 and P2 were messaged before any environment edits; this checkpoint leaves
their runtime.ts/environment.ts/launch-attribution ownership untouched. All
changed paths stay within P3's assigned Area. P10 received the detection contract
and exact one-line change. No push, merge, Daemon installation or upgrade occurred.
