# Auto-instrumentation (ENG-657)

`prepareAutoInstrumentation({checkout,cwd,settings,source,registerPath?,runtime?})`
returns `{environment,skipReason}`. `autoInstrumentationEnvironment` returns only
the environment patch. Call these only after Workspace Trust and checkout
ownership checks, with the injected receiver endpoint in `source`. The settings
owner records the read-only skip reason. No SDK runs inside the Daemon.

Off or disabled returns an empty patch. Node prepends `--import <register URL>` to
existing `NODE_OPTIONS`; it reads manifests from the launch directory through the
checkout root, including development, optional and peer dependencies. An existing
`@opentelemetry/sdk-node`, `sdk-trace-*` or `sdk-trace` dependency suppresses the
preload unless `autoInstrumentOverride` is set. The nearest package name becomes
`service.name`. Deno receives `OTEL_DENO=true`. A known Bun launch receives no
patch, and the register also refuses to initialize inside Bun. No `BUN_OPTIONS`
are changed.

`build.ts` bundles the pinned SDK and the ESM loader separately for Node, sharing
import-in-the-middle's registry file. `scripts/build-daemon.ts` embeds these as
data with a build plugin. On first opted-in launch, `assets.ts` materializes them
under a private content-addressed directory in the Daemon home. Existing apps can
keep their loader across Daemon upgrades. Development builds bundle lazily on
first use. The compiled Daemon does not need a checkout, npm, or node_modules to
materialize the register. Node itself remains a Host prerequisite.

The register enables HTTP, undici/fetch, pg, mysql2 and express instrumentation.
It configures both trace and log exporters with the Polaris endpoint, disables
metrics, bounds export time to one second and flushes finite commands on
`beforeExit`. Logs and traces share one HTTP connection because the receiver
admits one request per token. Setup and export failures do not crash the app;
telemetry is best effort when the endpoint is down. Explicit `process.exit` or a
forced process termination can lose pending telemetry. Signal handlers stay with
the app. Log records use the installed OTel API; this does not intercept console
output or install a logging framework.

`detectFixedExporters({checkout,appRan,spansArrived})` returns PC's read-only
`DetectedTraceExporter[]`. Call on an active read after observed application work,
not on a timer. It returns no evidence before a launch, after spans arrive, or
without an OTel dependency. Discovery uses safe git with standard ignore rules,
at most 256 KiB of filenames, 1,024 files, 64 KiB per regular file, 4 MiB of source
and 32 results. File reads reject symlinks, devices and paths outside the checkout.

This is conservative static evidence for a literal HTTP(S) `url` in an
`OTLPTraceExporter` or `OTLPExporter` constructor, not an evaluator. Aliases,
computed configuration, generated files and non-git directories are not inferred.
Comments, string examples, dynamic template URLs and existing endpoint fallbacks
are excluded. Evidence includes only checkout-relative file/line, with runtime
unknown; it never contains source or the collector URL. P10 can use
`fixedExporterChange` with file:line to ask for the research note's one-line fix:

```ts
url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? existingVendorUrl,
```

Preserve the existing URL as the fallback and retain the application's headers.
Absence of evidence is not proof that an application has no fixed exporter.

Run `bun test apps/daemon/src/traces/instrumentation` with native loopback access.
The tests launch a real Node ESM HTTP app making a fetch call, then read spans,
service name and correlated logs through the real receiver and SQLite store.
Other tests cover opt-in modes, hoisted SDK detection/override, endpoint failure,
compiled asset extraction, gitignore and bounded/symlink-safe discovery.

This helper checkpoint does not wire launch injection or settings detection yet:
P3 composes onto P1's accepted settings/runtime implementation in the next step.
